// asset_hub upload — turn a local `.glb`, or a `.zip` containing a `.gltf`
// plus the buffers/images it references, into files in the user's connected
// cloud drive. Runs entirely client-side: the archive is unpacked in the
// browser with `ui_zip_reader` and each resulting file is streamed straight
// to the `cloud_storage_provider` — nothing round-trips through a server.

import { read_zip_entries } from '../../storage/ui_zip_reader'
import type { cloud_storage_provider } from '../../storage/ui_cloud_storage_provider'
import { as_cloud_error, type cloud_file } from '../../storage/ui_cloud_types'

const GLTF_MIME = 'model/gltf+json'
const GLB_MIME = 'model/gltf-binary'

/** True for a file the upload picker/drop target should hand to `upload_local_files`. */
export function is_uploadable_asset_name(name: string): boolean {
  const ext = extension_of(name)
  return ext === 'glb' || ext === 'zip'
}

export interface upload_outcome {
  uploaded: cloud_file[]
  /** One message per file that failed or was skipped; empty on full success. */
  errors: string[]
}

interface planned_file {
  name: string
  data: Blob
}

/**
 * Upload every selected local file into `parent_id`: a `.glb` goes up as-is;
 * a `.zip` is unpacked and its `.gltf` plus the buffers/images it references
 * are uploaded alongside it (extras in the archive are ignored; a missing
 * referenced resource fails that file rather than uploading a broken scene).
 * When a zip needs more than one file, they land in a new subfolder named
 * after the archive so the `.gltf`'s relative URIs keep resolving.
 */
export async function upload_local_files(
  provider: cloud_storage_provider,
  parent_id: string,
  files: File[],
  on_progress?: (label: string) => void,
  signal?: AbortSignal,
): Promise<upload_outcome> {
  const uploaded: cloud_file[] = []
  const errors: string[] = []
  if (!provider.upload_file) {
    return { uploaded, errors: [`${provider.label} doesn't support uploading files.`] }
  }
  // Provider methods may use instance state (Google Drive calls
  // `this.api_json`). Preserve the receiver when reusing the method below.
  const upload_file = provider.upload_file.bind(provider)

  for (const file of files) {
    throw_if_aborted(signal)
    const ext = extension_of(file.name)
    try {
      if (ext === 'glb') {
        on_progress?.(`Uploading ${file.name}…`)
        uploaded.push(await upload_file(parent_id, file.name, file, GLB_MIME, signal))
      } else if (ext === 'zip') {
        on_progress?.(`Unpacking ${file.name}…`)
        const plan = await plan_zip_upload(file)
        throw_if_aborted(signal)
        let target_id = parent_id
        if (plan.length > 1) {
          if (!provider.create_folder) {
            throw new Error(`${provider.label} can't create the folder this scene needs — zip a self-contained .glb instead.`)
          }
          const folder = await provider.create_folder(parent_id, file.name.replace(/\.zip$/i, ''), signal)
          target_id = folder.id
        }
        for (const part of plan) {
          throw_if_aborted(signal)
          on_progress?.(`Uploading ${part.name}…`)
          uploaded.push(await upload_file(target_id, part.name, part.data, undefined, signal))
        }
      } else {
        errors.push(`"${file.name}" isn't a .glb or .zip — skipped.`)
      }
    } catch (err) {
      if (is_abort_error(err)) throw err
      const e = as_cloud_error(err)
      if (e?.kind === 'auth_expired') throw err
      console.error(`[Asset Hub] Upload "${file.name}" failed`, err)
      errors.push(e?.message ?? (err instanceof Error ? err.message : `Failed to upload "${file.name}".`))
    }
  }
  return { uploaded, errors }
}

function throw_if_aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Transfer cancelled.', 'AbortError')
}

function is_abort_error(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/** Unpack a zip and resolve exactly which of its entries the single `.gltf` inside it needs. */
async function plan_zip_upload(file: File): Promise<planned_file[]> {
  const entries = await read_zip_entries(file)
  const gltf_entries = entries.filter((entry) => extension_of(entry.path) === 'gltf')
  if (gltf_entries.length === 0) throw new Error(`"${file.name}" doesn't contain a .gltf file.`)
  if (gltf_entries.length > 1) throw new Error(`"${file.name}" contains more than one .gltf file — zip exactly one scene per archive.`)
  const gltf = gltf_entries[0]!
  const gltf_dir = gltf.path.includes('/') ? gltf.path.slice(0, gltf.path.lastIndexOf('/') + 1) : ''

  let doc: { buffers?: { uri?: string }[]; images?: { uri?: string }[] }
  try {
    doc = JSON.parse(new TextDecoder().decode(gltf.data)) as typeof doc
  } catch {
    throw new Error(`"${gltf.path}" in "${file.name}" isn't valid JSON.`)
  }

  const needed = new Set<string>()
  for (const ref of [...(doc.buffers ?? []), ...(doc.images ?? [])]) {
    if (ref.uri && !ref.uri.startsWith('data:')) needed.add(decodeURIComponent(ref.uri))
  }

  const plan: planned_file[] = [{ name: base_name(gltf.path), data: new Blob([gltf.data as BlobPart], { type: GLTF_MIME }) }]
  const missing: string[] = []
  for (const uri of needed) {
    const entry = entries.find((e) => e.path === `${gltf_dir}${uri}` || e.path === uri || e.path.endsWith(`/${uri}`))
    if (!entry) {
      missing.push(uri)
      continue
    }
    plan.push({ name: base_name(entry.path), data: new Blob([entry.data as BlobPart], { type: mime_for(entry.path) }) })
  }
  if (missing.length > 0) throw new Error(`"${file.name}" is missing resource(s) referenced by the .gltf: ${missing.join(', ')}.`)
  return plan
}

function base_name(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash >= 0 ? path.slice(slash + 1) : path
}

function extension_of(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function mime_for(name: string): string {
  switch (extension_of(name)) {
    case 'bin': return 'application/octet-stream'
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'ktx2': return 'image/ktx2'
    default: return 'application/octet-stream'
  }
}
