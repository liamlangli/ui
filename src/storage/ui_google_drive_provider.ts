// google_drive_provider — `cloud_storage_provider` backed by Google Drive.
//
// Pure browser implementation: OAuth runs through the Google Identity
// Services access-token flow (implicit, browser-only — no client secret, no
// backend), and file access goes through the Drive v3 REST API with `fetch`.
//
// The requested scope is `drive.file` — a non-sensitive scope that needs no
// Google app verification and shows no "unverified app" warning. Under it the
// app can only see files the user explicitly grants, so the asset hub root is
// chosen through the Google Picker (`pick_asset_hub_root`): the user picks
// their `asset_hub` folder once, the grant persists on their Google account,
// and the folder id is remembered in `localStorage` so later visits reopen it
// directly (`find_asset_hub_root` revalidates the stored id and returns null
// when access was lost, prompting a re-pick).
//
// The access token is kept in memory and mirrored to `sessionStorage` so a
// same-tab reload survives without a new consent popup; sessionStorage is
// per-tab and cleared when the tab closes. Tokens expire after ~1 hour —
// every API call re-checks expiry and 401 responses drop the token, so the
// UI can ask the user to sign in again instead of assuming it lives forever.

import { cloud_error, type cloud_file } from './ui_cloud_types'
import type { cloud_storage_provider } from './ui_cloud_storage_provider'

const GIS_SCRIPT_SRC = 'https://accounts.google.com/gsi/client'
const GAPI_SCRIPT_SRC = 'https://apis.google.com/js/api.js'
const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder'
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink'
const TOKEN_STORAGE_KEY = 'ui.cloud.gdrive.token'
const ROOT_STORAGE_KEY = 'ui.cloud.gdrive.root'
/** Treat tokens as expired slightly early so in-flight requests don't 401. */
const TOKEN_EXPIRY_MARGIN_MS = 30_000

// --- Google Identity Services ambient surface --------------------------------
// GIS is loaded at runtime from accounts.google.com; only the sliver of its
// API the token flow needs is declared here.
interface gis_token_response {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

interface gis_token_client {
  requestAccessToken(overrides?: { prompt?: string }): void
}

interface gis_oauth2 {
  initTokenClient(config: {
    client_id: string
    scope: string
    callback: (response: gis_token_response) => void
    error_callback?: (error: { type?: string; message?: string }) => void
  }): gis_token_client
  revoke(token: string, done?: () => void): void
}

// --- Google Picker ambient surface --------------------------------------------
// The Picker ships with the gapi loader (apis.google.com/js/api.js); only the
// builder surface the folder pick needs is declared here.
interface picker_docs_view {
  setSelectFolderEnabled(enabled: boolean): picker_docs_view
  setIncludeFolders(include: boolean): picker_docs_view
  setMimeTypes(types: string): picker_docs_view
}

interface picker_response {
  action: string
  docs?: { id: string; name: string; mimeType?: string }[]
}

interface picker_builder {
  addView(view: picker_docs_view): picker_builder
  setOAuthToken(token: string): picker_builder
  setDeveloperKey(key: string): picker_builder
  setAppId(app_id: string): picker_builder
  setTitle(title: string): picker_builder
  setCallback(callback: (data: picker_response) => void): picker_builder
  build(): { setVisible(visible: boolean): void }
}

interface picker_namespace {
  PickerBuilder: new () => picker_builder
  DocsView: new (view_id?: unknown) => picker_docs_view
  ViewId: { FOLDERS: unknown }
  Action: { PICKED: string; CANCEL: string }
}

interface google_window {
  google?: { accounts?: { oauth2?: gis_oauth2 }; picker?: picker_namespace }
  gapi?: { load(name: string, callback: () => void): void }
}

interface drive_file_resource {
  id: string
  name: string
  mimeType: string
  size?: string
  modifiedTime?: string
  webViewLink?: string
}

export interface google_drive_provider_options {
  /**
   * Optional Google API key passed to the Picker (`setDeveloperKey`). The
   * Picker usually works with the OAuth token alone; set this if Google
   * rejects the dialog with a developer-key error.
   */
  api_key?: string
}

export class google_drive_provider implements cloud_storage_provider {
  readonly label = 'Google Drive'

  private client_id: string
  private root_folder_name: string
  private api_key: string
  private access_token: string | null = null
  private token_expires_at = 0
  private gis_load: Promise<gis_oauth2> | null = null
  private picker_load: Promise<picker_namespace> | null = null

  constructor(client_id: string, root_folder_name = 'asset_hub', options?: google_drive_provider_options) {
    this.client_id = client_id
    this.root_folder_name = root_folder_name
    this.api_key = options?.api_key ?? ''
    this.restore_session_token()
  }

  // --- auth ------------------------------------------------------------------

  async sign_in(): Promise<void> {
    if (!this.client_id) {
      throw new cloud_error('config', 'Google client id is not configured (set VITE_GOOGLE_CLIENT_ID).')
    }
    const oauth2 = await this.load_gis()
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (err?: cloud_error) => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }
      const client = oauth2.initTokenClient({
        client_id: this.client_id,
        scope: DRIVE_FILE_SCOPE,
        callback: (response) => {
          if (!response.access_token) {
            settle(new cloud_error('auth', response.error_description ?? response.error ?? 'Google did not return an access token.'))
            return
          }
          this.store_token(response.access_token, response.expires_in ?? 3600)
          settle()
        },
        error_callback: (error) => {
          settle(new cloud_error('auth', error?.message ?? error?.type ?? 'Google sign-in was cancelled.'))
        },
      })
      client.requestAccessToken()
    })
  }

  async sign_out(): Promise<void> {
    const token = this.access_token
    this.clear_token()
    if (!token) return
    // Revocation is best effort — dropping the token already signs the app out.
    try {
      const oauth2 = await this.load_gis()
      await new Promise<void>((resolve) => oauth2.revoke(token, resolve))
    } catch {
      // GIS unavailable (offline) — the token simply expires on its own.
    }
  }

  is_signed_in(): boolean {
    return this.access_token !== null && Date.now() < this.token_expires_at - TOKEN_EXPIRY_MARGIN_MS
  }

  // --- root folder -------------------------------------------------------------

  async find_asset_hub_root(): Promise<cloud_file | null> {
    const saved = this.load_root()
    if (!saved) return null
    // Revalidate the stored id: the folder may have been deleted, or the
    // drive.file grant revoked (or this is a different Google account).
    try {
      const body = (await this.api_json(`${DRIVE_API}/files/${encodeURIComponent(saved.id)}?fields=${FILE_FIELDS}`)) as drive_file_resource
      if (body.mimeType !== DRIVE_FOLDER_MIME) {
        this.clear_root()
        return null
      }
      return to_cloud_file(body)
    } catch (err) {
      const e = err instanceof cloud_error ? err : null
      if (e?.kind === 'not_found') {
        this.clear_root()
        return null // folder deleted or grant lost — the UI offers the picker again
      }
      throw err
    }
  }

  async pick_asset_hub_root(): Promise<cloud_file | null> {
    if (!this.is_signed_in()) {
      throw new cloud_error('auth_expired', 'Your Google Drive session expired. Sign in again.')
    }
    const picker = await this.load_picker()
    const token = this.access_token!
    return new Promise<cloud_file | null>((resolve) => {
      const view = new picker.DocsView(picker.ViewId.FOLDERS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMimeTypes(DRIVE_FOLDER_MIME)
      let builder = new picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setTitle(`Select your ${this.root_folder_name} folder`)
        .setCallback((data) => {
          if (data.action === picker.Action.PICKED) {
            const doc = data.docs?.[0]
            if (!doc) {
              resolve(null)
              return
            }
            const root: cloud_file = { id: doc.id, name: doc.name, mime_type: doc.mimeType ?? DRIVE_FOLDER_MIME, is_folder: true }
            this.store_root(root)
            resolve(root)
          } else if (data.action === picker.Action.CANCEL) {
            resolve(null)
          }
        })
      // The app id (the project number, the client id's leading segment) ties
      // the picker grant to this app — required for drive.file access.
      const app_id = this.client_id.split('-')[0] ?? ''
      if (/^\d+$/.test(app_id)) builder = builder.setAppId(app_id)
      if (this.api_key) builder = builder.setDeveloperKey(this.api_key)
      builder.build().setVisible(true)
    })
  }

  // --- files -----------------------------------------------------------------

  async list_folder(folder_id: string): Promise<cloud_file[]> {
    const id = folder_id.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const files: cloud_file[] = []
    let page_token: string | undefined
    do {
      const params = new URLSearchParams({
        q: `'${id}' in parents and trashed = false`,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        orderBy: 'folder,name',
        pageSize: '200',
        spaces: 'drive',
      })
      if (page_token) params.set('pageToken', page_token)
      const body = (await this.api_json(`${DRIVE_API}/files?${params}`)) as {
        nextPageToken?: string
        files?: drive_file_resource[]
      }
      for (const raw of body.files ?? []) files.push(to_cloud_file(raw))
      page_token = body.nextPageToken
    } while (page_token)
    return files
  }

  async get_file_content(file: cloud_file): Promise<Blob> {
    const response = await this.api_fetch(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`)
    return response.blob()
  }

  async get_file_download_url(file: cloud_file): Promise<string> {
    const blob = await this.get_file_content(file)
    return URL.createObjectURL(blob)
  }

  // --- internals ---------------------------------------------------------------

  private load_gis(): Promise<gis_oauth2> {
    if (this.gis_load) return this.gis_load
    this.gis_load = new Promise<gis_oauth2>((resolve, reject) => {
      const existing = (window as unknown as google_window).google?.accounts?.oauth2
      if (existing) {
        resolve(existing)
        return
      }
      const script = document.createElement('script')
      script.src = GIS_SCRIPT_SRC
      script.async = true
      script.onload = () => {
        const oauth2 = (window as unknown as google_window).google?.accounts?.oauth2
        if (oauth2) resolve(oauth2)
        else reject(new cloud_error('auth', 'Google Identity Services loaded but the OAuth2 API is unavailable.'))
      }
      script.onerror = () => {
        this.gis_load = null // allow a retry after a transient network failure
        reject(new cloud_error('network', 'Failed to load Google Identity Services (accounts.google.com unreachable).'))
      }
      document.head.appendChild(script)
    })
    return this.gis_load
  }

  private load_picker(): Promise<picker_namespace> {
    if (this.picker_load) return this.picker_load
    this.picker_load = new Promise<picker_namespace>((resolve, reject) => {
      const load_module = () => {
        const w = window as unknown as google_window
        w.gapi!.load('picker', () => {
          const picker = (window as unknown as google_window).google?.picker
          if (picker) resolve(picker)
          else {
            this.picker_load = null
            reject(new cloud_error('api', 'Google Picker failed to initialize.'))
          }
        })
      }
      if ((window as unknown as google_window).gapi?.load) {
        load_module()
        return
      }
      const script = document.createElement('script')
      script.src = GAPI_SCRIPT_SRC
      script.async = true
      script.onload = load_module
      script.onerror = () => {
        this.picker_load = null
        reject(new cloud_error('network', 'Failed to load the Google API loader (apis.google.com unreachable).'))
      }
      document.head.appendChild(script)
    })
    return this.picker_load
  }

  private async api_fetch(url: string): Promise<Response> {
    if (!this.is_signed_in()) {
      this.clear_token()
      throw new cloud_error('auth_expired', 'Your Google Drive session expired. Sign in again.')
    }
    let response: Response
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${this.access_token}` } })
    } catch {
      throw new cloud_error('network', 'Network request to Google Drive failed.')
    }
    if (response.status === 401) {
      this.clear_token()
      throw new cloud_error('auth_expired', 'Your Google Drive session expired. Sign in again.')
    }
    if (response.status === 404) throw new cloud_error('not_found', 'File not found in Google Drive.')
    if (!response.ok) throw new cloud_error('api', `Google Drive API error (HTTP ${response.status}).`)
    return response
  }

  private async api_json(url: string): Promise<unknown> {
    const response = await this.api_fetch(url)
    try {
      return await response.json()
    } catch {
      throw new cloud_error('api', 'Google Drive returned an unreadable response.')
    }
  }

  private store_token(token: string, expires_in_s: number): void {
    this.access_token = token
    this.token_expires_at = Date.now() + expires_in_s * 1000
    try {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ token, expires_at: this.token_expires_at }))
    } catch {
      // storage unavailable (private mode / quota) — session just won't survive a reload
    }
  }

  private restore_session_token(): void {
    try {
      const raw = window.sessionStorage.getItem(TOKEN_STORAGE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as { token?: string; expires_at?: number }
      if (typeof saved.token === 'string' && typeof saved.expires_at === 'number' && Date.now() < saved.expires_at - TOKEN_EXPIRY_MARGIN_MS) {
        this.access_token = saved.token
        this.token_expires_at = saved.expires_at
      } else {
        window.sessionStorage.removeItem(TOKEN_STORAGE_KEY)
      }
    } catch {
      // storage unavailable or corrupt blob — start signed out
    }
  }

  private clear_token(): void {
    this.access_token = null
    this.token_expires_at = 0
    try {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY)
    } catch {
      // storage unavailable — nothing to clear
    }
  }

  private store_root(root: cloud_file): void {
    try {
      window.localStorage.setItem(ROOT_STORAGE_KEY, JSON.stringify({ id: root.id, name: root.name }))
    } catch {
      // storage unavailable — the user just re-picks next visit
    }
  }

  private load_root(): { id: string; name: string } | null {
    try {
      const raw = window.localStorage.getItem(ROOT_STORAGE_KEY)
      if (!raw) return null
      const saved = JSON.parse(raw) as { id?: string; name?: string }
      if (typeof saved.id === 'string' && saved.id) return { id: saved.id, name: saved.name ?? '' }
    } catch {
      // storage unavailable or corrupt blob
    }
    return null
  }

  private clear_root(): void {
    try {
      window.localStorage.removeItem(ROOT_STORAGE_KEY)
    } catch {
      // storage unavailable — nothing to clear
    }
  }
}

function to_cloud_file(raw: drive_file_resource): cloud_file {
  const size = raw.size !== undefined ? Number(raw.size) : undefined
  return {
    id: raw.id,
    name: raw.name,
    mime_type: raw.mimeType,
    is_folder: raw.mimeType === DRIVE_FOLDER_MIME,
    size_bytes: Number.isFinite(size) ? size : undefined,
    modified_time: raw.modifiedTime,
    web_view_url: raw.webViewLink,
  }
}
