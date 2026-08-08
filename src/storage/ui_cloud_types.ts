// Cloud storage types shared by every storage provider (Google Drive today;
// Dropbox / iCloud / local-folder providers can implement the same shapes
// later). App code should only ever see these types plus the
// `cloud_storage_provider` interface — never a provider's raw API payloads.

/** A file or folder as reported by a cloud storage provider. */
export interface cloud_file {
  /** Provider-scoped stable id (e.g. a Google Drive file id). */
  id: string
  name: string
  /** Provider-reported MIME type, e.g. `image/png` or the provider folder type. */
  mime_type: string
  is_folder: boolean
  size_bytes?: number
  /** ISO 8601 last-modified timestamp. */
  modified_time?: string
  /** Provider web page for the file (e.g. Google Drive's "open in Drive" link). */
  web_view_url?: string
  /**
   * Small app-private key/value metadata stored alongside the file (Google
   * Drive `appProperties`). A sync layer stamps a record's own version here,
   * so comparing local against remote costs a listing rather than a download.
   * Absent when the provider has no metadata support, and only ever populated
   * for files this app itself wrote.
   */
  properties?: Record<string, string>
}

export type cloud_error_kind =
  | 'config' // provider not configured (e.g. missing OAuth client id)
  | 'auth' // sign-in failed or was dismissed by the user
  | 'auth_expired' // access token expired or was revoked — sign in again
  | 'network' // the request never reached the provider
  | 'api' // the provider API returned an error
  | 'not_found'
  | 'forbidden' // the provider denied access to this specific item (HTTP 403)

/** Error thrown by storage providers; `kind` drives the UI state machine. */
export class cloud_error extends Error {
  kind: cloud_error_kind

  constructor(kind: cloud_error_kind, message: string) {
    super(message)
    this.name = 'cloud_error'
    this.kind = kind
  }
}

/** Narrow an unknown thrown value to a `cloud_error`, or null. */
export function as_cloud_error(err: unknown): cloud_error | null {
  return err instanceof cloud_error ? err : null
}

/** Coarse asset category derived from a file's name/MIME, used for previews. */
export type cloud_file_kind = 'folder' | 'image' | 'text' | 'model' | 'audio' | 'video' | 'other'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
const TEXT_EXTENSIONS = new Set(['json', 'txt', 'glsl', 'hlsl', 'wgsl', 'md'])
const MODEL_EXTENSIONS = new Set(['glb', 'gltf', 'obj', 'fbx', 'bin', 'bytes'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm'])

/** Classify a cloud file by extension first, MIME prefix as the fallback. */
export function cloud_file_kind_of(file: cloud_file): cloud_file_kind {
  if (file.is_folder) return 'folder'
  const dot = file.name.lastIndexOf('.')
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : ''
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (MODEL_EXTENSIONS.has(ext)) return 'model'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  const mime = file.mime_type
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('text/') || mime === 'application/json') return 'text'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  return 'other'
}
