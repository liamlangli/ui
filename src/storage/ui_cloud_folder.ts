// Folder and document helpers layered on `cloud_storage_provider`. None of
// this is provider- or app-specific: it is the small set of operations every
// app needs when it keeps its own records in a user's drive — resolve a
// subfolder by name, index a folder once instead of listing it per record,
// and write a named document create-or-update rather than piling up a new
// file on every save.
//
// Providers address files by opaque id, not by path, and generally allow two
// files to share a name in one folder. So "one file per record" is a
// convention the caller maintains: look the name up in a folder index, then
// route to `update_file` when it already exists and `upload_file` when it
// doesn't. `put_file` does exactly that.

import { cloud_error, type cloud_file } from './ui_cloud_types'
import type { cloud_storage_provider, cloud_write_options } from './ui_cloud_storage_provider'

/** Name → file for one folder's direct children, newest entry winning. */
export type cloud_folder_index = Map<string, cloud_file>

/**
 * List a folder once and index its children by name. Providers permit
 * duplicate names, so the most recently modified entry wins — a half-finished
 * write that left a stale twin behind never shadows the live record.
 */
export async function index_folder(provider: cloud_storage_provider, folder_id: string): Promise<cloud_folder_index> {
  const index: cloud_folder_index = new Map()
  for (const file of await provider.list_folder(folder_id)) {
    const existing = index.get(file.name)
    if (!existing || newer_than(file, existing)) index.set(file.name, file)
  }
  return index
}

function newer_than(a: cloud_file, b: cloud_file): boolean {
  return (a.modified_time ?? '') > (b.modified_time ?? '')
}

/** Find a direct child by exact name, or null. Prefer `index_folder` in a loop. */
export async function find_child(
  provider: cloud_storage_provider,
  folder_id: string,
  name: string,
): Promise<cloud_file | null> {
  return (await index_folder(provider, folder_id)).get(name) ?? null
}

/**
 * Resolve a subfolder by name, creating it when absent. Requires a writable
 * provider only in the create case, so a read-only session still resolves a
 * folder that already exists.
 */
export async function ensure_folder(
  provider: cloud_storage_provider,
  parent_id: string,
  name: string,
  signal?: AbortSignal,
): Promise<cloud_file> {
  const existing = await find_child(provider, parent_id, name)
  if (existing?.is_folder) return existing
  if (!provider.create_folder) {
    throw new cloud_error('forbidden', `${provider.label} can't create the "${name}" folder in this session.`)
  }
  return provider.create_folder(parent_id, name, signal)
}

/**
 * Write `data` to the file named `name` in `folder_id`: updates it in place
 * when it already exists, creates it otherwise. Pass the `index` from
 * `index_folder` when writing many records so the folder is listed once.
 * Returns the resulting file, which callers should feed back into their index.
 */
export async function put_file(
  provider: cloud_storage_provider,
  folder_id: string,
  name: string,
  data: Blob,
  options?: cloud_write_options,
  index?: cloud_folder_index,
): Promise<cloud_file> {
  const existing = index ? index.get(name) : await find_child(provider, folder_id, name)
  if (existing && !existing.is_folder) {
    if (!provider.update_file) {
      throw new cloud_error('forbidden', `${provider.label} can't rewrite existing files in this session.`)
    }
    const updated = await provider.update_file(existing.id, data, options)
    index?.set(name, updated)
    return updated
  }
  if (!provider.upload_file) {
    throw new cloud_error('forbidden', `${provider.label} can't create files in this session.`)
  }
  const created = await provider.upload_file(folder_id, name, data, options)
  index?.set(name, created)
  return created
}

/** True when the provider can be used as a read-write document store. */
export function is_writable(provider: cloud_storage_provider): boolean {
  return Boolean(provider.upload_file && provider.update_file && provider.create_folder)
}

/**
 * Download a file and parse it as JSON. Throws a `cloud_error` of kind `api`
 * on unparseable content, so a truncated or hand-edited document surfaces the
 * same way as any other provider failure instead of as a raw SyntaxError.
 */
export async function read_json<T>(
  provider: cloud_storage_provider,
  file: cloud_file,
  signal?: AbortSignal,
): Promise<T> {
  const blob = await provider.get_file_content(file, signal)
  const text = await blob.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new cloud_error('api', `"${file.name}" in ${provider.label} is not valid JSON.`)
  }
}

/** Serialize `value` and `put_file` it as `name.json`-style document. */
export async function write_json(
  provider: cloud_storage_provider,
  folder_id: string,
  name: string,
  value: unknown,
  options?: cloud_write_options,
  index?: cloud_folder_index,
): Promise<cloud_file> {
  const data = new Blob([JSON.stringify(value)], { type: 'application/json' })
  return put_file(provider, folder_id, name, data, { mime_type: 'application/json', ...options }, index)
}
