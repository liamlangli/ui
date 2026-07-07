// asset_market — self-contained Draco-style geometry codec.
//
// The marketplace sells whole scenes as .glb; their geometry travels
// Draco-compressed. This module implements the compress / decompress round-trip
// with no external dependency (the project ships no Draco wasm): positions,
// normals and uvs are quantized, delta-coded against the previous vertex and
// packed as zig-zag varints, and the triangle indices are delta varints too.
// The container mirrors Draco's shape — a quantized, entropy-light payload the
// {@link ui_asset_market_worker} thread encodes and decodes off the main thread.
//
// It is intentionally NOT byte-compatible with Google's Draco binary: it is a
// compact, reversible geometry codec you can read end to end. Quantization is
// lossy within the chosen bit budget, exactly as Draco's own quantization is.

/** One whole-scene mesh, flattened into tight typed arrays. */
export interface scene_geometry {
  /** xyz per vertex. */
  positions: Float32Array
  /** xyz per vertex, or null when the scene shipped none. */
  normals: Float32Array | null
  /** uv per vertex, or null when the scene shipped none. */
  uvs: Float32Array | null
  /** Triangle-list indices into the vertex arrays. */
  indices: Uint32Array
}

export interface draco_encode_options {
  /** Quantization bits per position component (default 14). */
  position_bits?: number
  /** Quantization bits per octahedral normal component (default 10). */
  normal_bits?: number
  /** Quantization bits per uv component (default 12). */
  uv_bits?: number
}

const MAGIC = 0x4f435244 // 'DRCO', read little-endian
const VERSION = 1
const FLAG_NORMALS = 1 << 0
const FLAG_UVS = 1 << 1

// --- little-endian byte streams ---------------------------------------------

class byte_writer {
  private buf = new Uint8Array(1024)
  private len = 0

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return
    let next = this.buf.length * 2
    while (next < this.len + extra) next *= 2
    const grown = new Uint8Array(next)
    grown.set(this.buf.subarray(0, this.len))
    this.buf = grown
  }

  u8(v: number): void {
    this.ensure(1)
    this.buf[this.len++] = v & 0xff
  }

  u32(v: number): void {
    this.ensure(4)
    this.buf[this.len++] = v & 0xff
    this.buf[this.len++] = (v >>> 8) & 0xff
    this.buf[this.len++] = (v >>> 16) & 0xff
    this.buf[this.len++] = (v >>> 24) & 0xff
  }

  f32(v: number): void {
    this.ensure(4)
    const dv = new DataView(this.buf.buffer, this.len, 4)
    dv.setFloat32(0, v, true)
    this.len += 4
  }

  /** Unsigned LEB128. Accepts any 32-bit unsigned value. */
  varint(v: number): void {
    v = v >>> 0
    while (v >= 0x80) {
      this.u8((v & 0x7f) | 0x80)
      v = v >>> 7
    }
    this.u8(v)
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}

class byte_reader {
  private pos = 0
  private dv: DataView
  constructor(private bytes: Uint8Array) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  u8(): number {
    return this.bytes[this.pos++] ?? 0
  }

  u32(): number {
    const v = this.dv.getUint32(this.pos, true)
    this.pos += 4
    return v
  }

  f32(): number {
    const v = this.dv.getFloat32(this.pos, true)
    this.pos += 4
    return v
  }

  varint(): number {
    let shift = 0
    let result = 0
    for (;;) {
      const b = this.u8()
      result += (b & 0x7f) * 2 ** shift
      if (b < 0x80) break
      shift += 7
    }
    return result >>> 0
  }
}

// zig-zag maps signed deltas to small unsigned varints.
function zigzag(v: number): number {
  return ((v << 1) ^ (v >> 31)) >>> 0
}
function unzigzag(v: number): number {
  return (v >>> 1) ^ -(v & 1)
}

// --- octahedral normal packing ----------------------------------------------

function oct_encode(x: number, y: number, z: number): [number, number] {
  const inv = 1 / (Math.abs(x) + Math.abs(y) + Math.abs(z) || 1)
  let u = x * inv
  let v = y * inv
  if (z < 0) {
    const ou = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1)
    const ov = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1)
    u = ou
    v = ov
  }
  return [u, v]
}

function oct_decode(u: number, v: number): [number, number, number] {
  let x = u
  let y = v
  let z = 1 - Math.abs(u) - Math.abs(v)
  if (z < 0) {
    const ox = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1)
    const oy = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1)
    x = ox
    y = oy
  }
  const len = Math.hypot(x, y, z) || 1
  return [x / len, y / len, z / len]
}

// --- quantization helpers ---------------------------------------------------

function quantize(value: number, min: number, range: number, levels: number): number {
  if (range <= 0) return 0
  const t = (value - min) / range
  const q = Math.round(t * (levels - 1))
  return q < 0 ? 0 : q > levels - 1 ? levels - 1 : q
}

function dequantize(q: number, min: number, range: number, levels: number): number {
  if (range <= 0) return min
  return min + (q / (levels - 1)) * range
}

// signed [-1,1] → [0, levels-1]
function quantize_signed(value: number, levels: number): number {
  return quantize(value, -1, 2, levels)
}
function dequantize_signed(q: number, levels: number): number {
  return dequantize(q, -1, 2, levels)
}

interface axis_bounds {
  min: number[]
  range: number[]
}

function bounds(values: Float32Array, components: number): axis_bounds {
  const min = new Array<number>(components).fill(Infinity)
  const max = new Array<number>(components).fill(-Infinity)
  for (let i = 0; i < values.length; i += components) {
    for (let c = 0; c < components; c += 1) {
      const v = values[i + c]!
      if (v < min[c]!) min[c] = v
      if (v > max[c]!) max[c] = v
    }
  }
  const range = min.map((lo, c) => Math.max(0, max[c]! - lo))
  return { min: min.map((v) => (Number.isFinite(v) ? v : 0)), range }
}

// --- public API -------------------------------------------------------------

/** Compress a scene's geometry into the Draco-style container. */
export function encode_draco_geometry(geo: scene_geometry, options?: draco_encode_options): Uint8Array {
  const pos_bits = clamp_bits(options?.position_bits ?? 14)
  const nrm_bits = clamp_bits(options?.normal_bits ?? 10)
  const uv_bits = clamp_bits(options?.uv_bits ?? 12)
  const vertex_count = (geo.positions.length / 3) | 0
  const has_normals = !!geo.normals && geo.normals.length === vertex_count * 3
  const has_uvs = !!geo.uvs && geo.uvs.length === vertex_count * 2

  const w = new byte_writer()
  w.u32(MAGIC)
  w.u8(VERSION)
  w.u8((has_normals ? FLAG_NORMALS : 0) | (has_uvs ? FLAG_UVS : 0))
  w.u8(pos_bits)
  w.u8(nrm_bits)
  w.u8(uv_bits)
  w.u32(vertex_count)
  w.u32(geo.indices.length)

  const pos_b = bounds(geo.positions, 3)
  for (let c = 0; c < 3; c += 1) w.f32(pos_b.min[c]!)
  for (let c = 0; c < 3; c += 1) w.f32(pos_b.range[c]!)

  let uv_b: axis_bounds = { min: [0, 0], range: [0, 0] }
  if (has_uvs) {
    uv_b = bounds(geo.uvs!, 2)
    for (let c = 0; c < 2; c += 1) w.f32(uv_b.min[c]!)
    for (let c = 0; c < 2; c += 1) w.f32(uv_b.range[c]!)
  }

  // Positions: per-component delta vs the previous vertex.
  const pos_levels = 1 << pos_bits
  const prev_pos = [0, 0, 0]
  for (let v = 0; v < vertex_count; v += 1) {
    for (let c = 0; c < 3; c += 1) {
      const q = quantize(geo.positions[v * 3 + c]!, pos_b.min[c]!, pos_b.range[c]!, pos_levels)
      w.varint(zigzag(q - prev_pos[c]!))
      prev_pos[c] = q
    }
  }

  if (has_normals) {
    const nrm_levels = 1 << nrm_bits
    const prev_n = [0, 0]
    for (let v = 0; v < vertex_count; v += 1) {
      const [u, t] = oct_encode(geo.normals![v * 3]!, geo.normals![v * 3 + 1]!, geo.normals![v * 3 + 2]!)
      const qu = quantize_signed(u, nrm_levels)
      const qt = quantize_signed(t, nrm_levels)
      w.varint(zigzag(qu - prev_n[0]!))
      w.varint(zigzag(qt - prev_n[1]!))
      prev_n[0] = qu
      prev_n[1] = qt
    }
  }

  if (has_uvs) {
    const uv_levels = 1 << uv_bits
    const prev_uv = [0, 0]
    for (let v = 0; v < vertex_count; v += 1) {
      for (let c = 0; c < 2; c += 1) {
        const q = quantize(geo.uvs![v * 2 + c]!, uv_b.min[c]!, uv_b.range[c]!, uv_levels)
        w.varint(zigzag(q - prev_uv[c]!))
        prev_uv[c] = q
      }
    }
  }

  // Indices: delta vs the previous index (triangle-list order).
  let prev_i = 0
  for (let i = 0; i < geo.indices.length; i += 1) {
    const idx = geo.indices[i]!
    w.varint(zigzag(idx - prev_i))
    prev_i = idx
  }

  return w.finish()
}

/** Decompress a Draco-style container back into scene geometry. */
export function decode_draco_geometry(bytes: Uint8Array): scene_geometry {
  const r = new byte_reader(bytes)
  if (r.u32() !== MAGIC) throw new Error('not a Draco-style geometry container')
  const version = r.u8()
  if (version !== VERSION) throw new Error(`unsupported container version ${version}`)
  const flags = r.u8()
  const pos_bits = r.u8()
  const nrm_bits = r.u8()
  const uv_bits = r.u8()
  const vertex_count = r.u32()
  const index_count = r.u32()
  const has_normals = (flags & FLAG_NORMALS) !== 0
  const has_uvs = (flags & FLAG_UVS) !== 0

  const pos_min = [r.f32(), r.f32(), r.f32()]
  const pos_range = [r.f32(), r.f32(), r.f32()]
  let uv_min = [0, 0]
  let uv_range = [0, 0]
  if (has_uvs) {
    uv_min = [r.f32(), r.f32()]
    uv_range = [r.f32(), r.f32()]
  }

  const positions = new Float32Array(vertex_count * 3)
  const pos_levels = 1 << pos_bits
  const prev_pos = [0, 0, 0]
  for (let v = 0; v < vertex_count; v += 1) {
    for (let c = 0; c < 3; c += 1) {
      const q = prev_pos[c]! + unzigzag(r.varint())
      prev_pos[c] = q
      positions[v * 3 + c] = dequantize(q, pos_min[c]!, pos_range[c]!, pos_levels)
    }
  }

  let normals: Float32Array | null = null
  if (has_normals) {
    normals = new Float32Array(vertex_count * 3)
    const nrm_levels = 1 << nrm_bits
    const prev_n = [0, 0]
    for (let v = 0; v < vertex_count; v += 1) {
      const qu = prev_n[0]! + unzigzag(r.varint())
      const qt = prev_n[1]! + unzigzag(r.varint())
      prev_n[0] = qu
      prev_n[1] = qt
      const [x, y, z] = oct_decode(dequantize_signed(qu, nrm_levels), dequantize_signed(qt, nrm_levels))
      normals[v * 3] = x
      normals[v * 3 + 1] = y
      normals[v * 3 + 2] = z
    }
  }

  let uvs: Float32Array | null = null
  if (has_uvs) {
    uvs = new Float32Array(vertex_count * 2)
    const uv_levels = 1 << uv_bits
    const prev_uv = [0, 0]
    for (let v = 0; v < vertex_count; v += 1) {
      for (let c = 0; c < 2; c += 1) {
        const q = prev_uv[c]! + unzigzag(r.varint())
        prev_uv[c] = q
        uvs[v * 2 + c] = dequantize(q, uv_min[c]!, uv_range[c]!, uv_levels)
      }
    }
  }

  const indices = new Uint32Array(index_count)
  let prev_i = 0
  for (let i = 0; i < index_count; i += 1) {
    const idx = prev_i + unzigzag(r.varint())
    indices[i] = idx
    prev_i = idx
  }

  return { positions, normals, uvs, indices }
}

function clamp_bits(bits: number): number {
  const b = Math.round(bits)
  return b < 2 ? 2 : b > 20 ? 20 : b
}
