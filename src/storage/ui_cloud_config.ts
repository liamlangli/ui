// Cloud storage configuration. Nothing here is specific to one app: the
// OAuth client id comes from the build environment (`VITE_GOOGLE_CLIENT_ID`
// in a `.env` file or the shell), and the hosting app supplies its own
// `app_id`, which namespaces every persisted key so two apps served from the
// same origin never share a token or a root folder. A client id is a public
// identifier; no client secret is ever shipped to (or needed by) the browser.

export interface cloud_config {
  /** Google OAuth 2.0 Web application client id; empty when unconfigured. */
  google_client_id: string
  /**
   * Optional Google API key handed to the Google Picker. The Picker usually
   * works with the OAuth token alone; set VITE_GOOGLE_API_KEY if Google
   * rejects the picker dialog with a developer-key error.
   */
  google_api_key: string
  /**
   * Stable identifier for the hosting app. Namespaces the `localStorage` keys
   * a provider writes (token, root folder), so the asset browser and a
   * different app on the same origin keep independent sessions.
   */
  app_id: string
  /** Suggested root folder name shown in the picker prompt. */
  root_folder_name: string
}

/** Used when the host passes no `app_id` and the environment sets none. */
export const DEFAULT_APP_ID = 'app'

export interface cloud_config_defaults {
  /** App namespace; `VITE_CLOUD_APP_ID` overrides it when set. */
  app_id?: string
  /** Root folder name; `VITE_CLOUD_ROOT_FOLDER` overrides it when set. */
  root_folder_name?: string
  /**
   * Environment record to read. Defaults to `import.meta.env`, which is what
   * a Vite app wants; pass an explicit record in tests or under another
   * bundler.
   */
  env?: Record<string, string | undefined>
}

/**
 * Reduce an arbitrary string to the `[a-z0-9_-]` subset used in storage keys,
 * so an app id taken from config can never produce a surprising key shape.
 */
export function sanitize_app_id(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || DEFAULT_APP_ID
}

/**
 * Read the cloud configuration from the build environment, falling back to
 * the host's `defaults`. An empty `google_client_id` means "not configured" —
 * hosts should surface a clear configuration message instead of attempting to
 * sign in. `root_folder_name` falls back to `app_id` so a host that names
 * itself gets a sensibly named Drive folder for free.
 */
export function load_cloud_config(defaults: cloud_config_defaults = {}): cloud_config {
  const env = defaults.env ?? (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const app_id = sanitize_app_id(env?.VITE_CLOUD_APP_ID?.trim() || defaults.app_id || DEFAULT_APP_ID)
  return {
    google_client_id: env?.VITE_GOOGLE_CLIENT_ID?.trim() ?? '',
    google_api_key: env?.VITE_GOOGLE_API_KEY?.trim() ?? '',
    app_id,
    root_folder_name: env?.VITE_CLOUD_ROOT_FOLDER?.trim() || defaults.root_folder_name?.trim() || app_id,
  }
}
