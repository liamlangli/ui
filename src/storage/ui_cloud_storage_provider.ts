// cloud_storage_provider — the storage abstraction app code depends on.
// Callers take this interface (never a concrete provider), so a Dropbox /
// iCloud / local-folder backend only has to implement these methods to plug
// into the same app.
//
// Everything runs in the browser: providers authenticate with a client-side
// OAuth flow (no client secret, no backend) and stream file bytes directly
// from the storage service to the page.
//
// Only reading is mandatory. `upload_file` / `update_file` / `create_folder` /
// `delete_file` are optional, so a read-only backend (or a grant whose scope
// can't write) simply leaves them unset and callers hide the corresponding
// actions. An app that keeps its own documents in the user's drive needs the
// write half; an asset browser needs only the read half.

import type { cloud_file } from './ui_cloud_types'

/** Options shared by the two write paths (`upload_file`, `update_file`). */
export interface cloud_write_options {
  /** Defaults to `data.type`, then `application/octet-stream`. */
  mime_type?: string
  /**
   * App-private metadata to store with the file, surfaced again as
   * `cloud_file.properties`. Providers without metadata support ignore it —
   * callers must treat it as a cache, never as the only copy of a value.
   */
  properties?: Record<string, string>
  signal?: AbortSignal
}

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
   * Locate the app's root folder if one was already granted (e.g. the Drive
   * folder the user picked on a previous visit), revalidated against the
   * provider. Resolves null when no root is known or it is no longer
   * accessible — callers then offer `pick_root_folder` again.
   */
  find_root_folder(): Promise<cloud_file | null>

  /**
   * Ask the user to grant a root folder through the provider's picker UI
   * (e.g. the Google Picker under the `drive.file` scope, where the app can
   * only ever see what the user explicitly selects). Resolves the picked
   * folder — persisted so `find_root_folder` returns it next time — or null
   * when the user cancels. Optional: providers whose scope can already see
   * the drive root don't need a picker.
   */
  pick_root_folder?(): Promise<cloud_file | null>

  /** List the direct children of a folder, folders first, sorted by name. */
  list_folder(folder_id: string): Promise<cloud_file[]>

  /**
   * Download the file and return a browser-local object URL for its bytes.
   * The caller owns the URL and must release it with `URL.revokeObjectURL`.
   */
  get_file_download_url(file: cloud_file, signal?: AbortSignal): Promise<string>

  /** Download the file's raw bytes. */
  get_file_content(file: cloud_file, signal?: AbortSignal): Promise<Blob>

  /**
   * Create a new file named `name` inside `folder_id`. Always creates —
   * providers generally allow duplicate names in one folder, so a caller
   * keeping one file per record must look the name up first and route an
   * existing id to `update_file`.
   */
  upload_file?(folder_id: string, name: string, data: Blob, options?: cloud_write_options): Promise<cloud_file>

  /**
   * Replace the contents (and optionally the metadata) of an existing file,
   * keeping its id, parents and sharing intact. This is what lets an app use
   * the drive as durable storage for records it rewrites, rather than
   * accumulating a new file per save.
   */
  update_file?(file_id: string, data: Blob, options?: cloud_write_options): Promise<cloud_file>

  /** Create a subfolder named `name` inside `folder_id`. */
  create_folder?(folder_id: string, name: string, signal?: AbortSignal): Promise<cloud_file>

  /**
   * Remove a file or folder. Providers may implement this as a move to trash
   * rather than a permanent delete — callers must not rely on the bytes being
   * unrecoverable.
   */
  delete_file?(file_id: string, signal?: AbortSignal): Promise<void>
}
