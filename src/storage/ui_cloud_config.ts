// Cloud storage configuration. The Google OAuth client id is not hardcoded in
// business code: it comes from the build environment (`VITE_GOOGLE_CLIENT_ID`
// in a `.env` file or the shell — see README "Asset Hub — cloud drive
// viewer"). A client id is a public identifier; no client secret is ever
// shipped to (or needed by) the browser.

export interface cloud_config {
  /** Google OAuth 2.0 Web application client id; empty when unconfigured. */
  google_client_id: string
  /** Folder name looked up in the drive root, `asset_hub` by default. */
  default_root_folder_name: string
}

export const DEFAULT_ROOT_FOLDER_NAME = 'asset_hub'

/**
 * Read the cloud configuration from the Vite build environment. An empty
 * `google_client_id` means "not configured" — hosts should surface a clear
 * configuration message instead of attempting to sign in.
 */
export function load_cloud_config(): cloud_config {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  return {
    google_client_id: env?.VITE_GOOGLE_CLIENT_ID?.trim() ?? '',
    default_root_folder_name: env?.VITE_CLOUD_ROOT_FOLDER?.trim() || DEFAULT_ROOT_FOLDER_NAME,
  }
}
