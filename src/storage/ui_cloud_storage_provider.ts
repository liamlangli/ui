// cloud_storage_provider — the storage abstraction the asset hub UI depends
// on. UI components take this interface (never a concrete provider), so a
// Dropbox / iCloud / local-folder backend only has to implement these seven
// methods to plug into the same browser.
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
   * Locate the asset hub root folder (e.g. the `asset_hub/` folder in the
   * user's Drive root). Resolves null when the folder does not exist — the
   * viewer is read-only and never creates it.
   */
  find_asset_hub_root(): Promise<cloud_file | null>

  /** List the direct children of a folder, folders first, sorted by name. */
  list_folder(folder_id: string): Promise<cloud_file[]>

  /**
   * Download the file and return a browser-local object URL for its bytes.
   * The caller owns the URL and must release it with `URL.revokeObjectURL`.
   */
  get_file_download_url(file: cloud_file): Promise<string>

  /** Download the file's raw bytes. */
  get_file_content(file: cloud_file): Promise<Blob>
}
