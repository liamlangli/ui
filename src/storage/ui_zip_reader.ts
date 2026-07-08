// zip_reader — minimal, dependency-free ZIP archive reader used to pull a
// glTF (plus its sibling .bin / texture files) out of a .zip dropped on the
// Asset Hub upload picker.
//
// Parses the ZIP central directory by hand (no zip64 support — plenty for
// the small asset archives this feeds) and inflates DEFLATE entries with the
// platform's native `DecompressionStream('deflate-raw')`; STORE entries are
// copied as-is. Everything runs in the browser on an in-memory `ArrayBuffer`.

export interface zip_entry {
  /** Path as stored in the archive, e.g. `model/scene.gltf`. Directory entries are omitted. */
  path: string
  data: Uint8Array
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIR_SIGNATURE = 0x02014b50
const EOCD_MIN_SIZE = 22
const MAX_COMMENT_SIZE = 65535

/** Read every file entry (skipping directories) out of a ZIP archive blob. */
export async function read_zip_entries(blob: Blob): Promise<zip_entry[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd_offset = find_end_of_central_directory(view)
  if (eocd_offset < 0) throw new Error('Not a valid ZIP archive (end-of-central-directory record not found).')

  const entry_count = view.getUint16(eocd_offset + 10, true)
  let dir_offset = view.getUint32(eocd_offset + 16, true)

  const entries: zip_entry[] = []
  for (let i = 0; i < entry_count; i += 1) {
    if (dir_offset + 46 > bytes.length || view.getUint32(dir_offset, true) !== CENTRAL_DIR_SIGNATURE) break
    const method = view.getUint16(dir_offset + 10, true)
    const compressed_size = view.getUint32(dir_offset + 20, true)
    const name_len = view.getUint16(dir_offset + 28, true)
    const extra_len = view.getUint16(dir_offset + 30, true)
    const comment_len = view.getUint16(dir_offset + 32, true)
    const local_offset = view.getUint32(dir_offset + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(dir_offset + 46, dir_offset + 46 + name_len))
    dir_offset += 46 + name_len + extra_len + comment_len

    if (name.endsWith('/')) continue // directory entry — no data to read

    const local_name_len = view.getUint16(local_offset + 26, true)
    const local_extra_len = view.getUint16(local_offset + 28, true)
    const data_offset = local_offset + 30 + local_name_len + local_extra_len
    const compressed = bytes.subarray(data_offset, data_offset + compressed_size)

    let data: Uint8Array
    if (method === 0) data = compressed
    else if (method === 8) data = await inflate_raw(compressed)
    else throw new Error(`Unsupported ZIP compression method (${method}) for "${name}" — only store and deflate are supported.`)

    entries.push({ path: name, data })
  }
  return entries
}

/** Scan backward for the EOCD signature — it can be preceded by up to 64KB of archive comment. */
function find_end_of_central_directory(view: DataView): number {
  const min_offset = Math.max(0, view.byteLength - EOCD_MIN_SIZE - MAX_COMMENT_SIZE)
  for (let offset = view.byteLength - EOCD_MIN_SIZE; offset >= min_offset; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset
  }
  return -1
}

async function inflate_raw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress ZIP archives (DecompressionStream is unsupported).')
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
