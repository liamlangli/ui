// cloud_storage_provider — the storage abstraction the asset hub UI depends
// on. UI components take this interface (never a concrete provider), so a
// Dropbox / iCloud / local-folder backend only has to implement these
// methods to plug into the same browser. `upload_file` / `create_folder` are
// optional — a provider (or grant scope) that can't write leaves them unset
// and the UI simply hides the Upload button.
//
// Everything runs in the browser: providers authenticate with a client-side
// OAuth flow (no client secret, no backend) and stream file bytes directly
// from the storage service to the page.

import type { cloud_file } from './ui_cloud_types'

export interface cloud_storage_provider {
  /** Human-readable provider name, e.g. `Google Drive`. */
  readonly label: string

  /**
   * Interactive sign-in (opens the provider's OAuth consent flow). Resolves
   * once an access token is held; rejects with a `cloud_error` of kind
   * `auth` when the user dismisses the prompt or the flow fails.
   */
  sign_in(): Promise<void>

  /** Drop the current session and revoke the access token (best effort). */
  sign_out(): Promise<void>

  /** True while an unexpired access token is held. */
  is_signed_in(): boolean

  /**
   * Locate the asset hub root folder the app already has access to (e.g. the
   * Drive folder the user granted through the picker on a previous visit,
   * revalidated against the provider). Resolves null when no root is known or
   * it is no longer accessible — the viewer is read-only and never creates it.
   */
  find_asset_hub_root(): Promise<cloud_file | null>

  /**
   * Ask the user to grant a root folder through the provider's picker UI
   * (e.g. the Google Picker under the `drive.file` scope, where the app can
   * only ever see what the user explicitly selects). Resolves the picked
   * folder — persisted so `find_asset_hub_root` returns it next time — or
   * null when the user cancels. Optional: providers whose scope can already
   * see the drive root don't need a picker.
   */
  pick_asset_hub_root?(): Promise<cloud_file | null>

  /** List the direct children of a folder, folders first, sorted by name. */
  list_folder(folder_id: string): Promise<cloud_file[]>

  /**
   * Download the file and return a browser-local object URL for its bytes.
   * The caller owns the URL and must release it with `URL.revokeObjectURL`.
   */
  get_file_download_url(file: cloud_file): Promise<string>

  /** Download the file's raw bytes. */
  get_file_content(file: cloud_file): Promise<Blob>

  /**
   * Upload `data` as a new file named `name` inside `folder_id`. `mime_type`
   * defaults to `data.type`, then `application/octet-stream`. Optional: only
   * providers that can write into the granted folder implement this.
   */
  upload_file?(folder_id: string, name: string, data: Blob, mime_type?: string): Promise<cloud_file>

  /** Create a subfolder named `name` inside `folder_id`. Optional, see `upload_file`. */
  create_folder?(folder_id: string, name: string): Promise<cloud_file>
}
