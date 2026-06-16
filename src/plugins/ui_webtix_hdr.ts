import default_webtix_hdr_url from '../../assets/brown_photostudio_02_1k.hdr?url'

export interface webtix_hdr_image {
  width: number
  height: number
  data: Float32Array
}

export { default_webtix_hdr_url }

const decoder = new TextDecoder('ascii')

export function parse_webtix_hdr(buffer: ArrayBuffer): webtix_hdr_image {
  const bytes = new Uint8Array(buffer)
  let offset = 0
  let format = ''
  let exposure = 1

  while (offset < bytes.length) {
    const line_start = offset
    while (offset < bytes.length && bytes[offset] !== 10) offset++
    const line_end = offset > line_start && bytes[offset - 1] === 13 ? offset - 1 : offset
    const line = decoder.decode(bytes.subarray(line_start, line_end)).trim()
    offset += offset < bytes.length ? 1 : 0
    if (line === '') break
    if (line.startsWith('FORMAT=')) format = line.slice(7)
    else if (line.startsWith('EXPOSURE=')) exposure *= Number.parseFloat(line.slice(9)) || 1
  }

  const res_start = offset
  while (offset < bytes.length && bytes[offset] !== 10) offset++
  const res_end = offset > res_start && bytes[offset - 1] === 13 ? offset - 1 : offset
  const res = decoder.decode(bytes.subarray(res_start, res_end)).trim()
  offset += offset < bytes.length ? 1 : 0

  if (format && format !== '32-bit_rle_rgbe') throw new Error(`unsupported HDR format: ${format}`)
  const match = /^([+-])Y\s+(\d+)\s+([+-])X\s+(\d+)$/.exec(res)
  if (!match) throw new Error('HDR missing Radiance resolution line')
  const y_sign = match[1]!
  const height = Number.parseInt(match[2]!, 10)
  const x_sign = match[3]!
  const width = Number.parseInt(match[4]!, 10)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('HDR has invalid dimensions')

  const rgbe = decode_rgbe(bytes, offset, width, height)
  const data = new Float32Array(width * height * 3)
  const inv_exposure = 1 / Math.max(1e-6, exposure)

  for (let src_y = 0; src_y < height; src_y++) {
    const dst_y = y_sign === '-' ? src_y : height - 1 - src_y
    for (let src_x = 0; src_x < width; src_x++) {
      const dst_x = x_sign === '+' ? src_x : width - 1 - src_x
      const si = (src_y * width + src_x) * 4
      const di = (dst_y * width + dst_x) * 3
      const e = rgbe[si + 3]!
      if (e === 0) continue
      const scale = Math.pow(2, e - 136) * inv_exposure
      data[di] = (rgbe[si]! + 0.5) * scale
      data[di + 1] = (rgbe[si + 1]! + 0.5) * scale
      data[di + 2] = (rgbe[si + 2]! + 0.5) * scale
    }
  }

  return { width, height, data }
}

function decode_rgbe(bytes: Uint8Array, offset: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4)
  const scanline = new Uint8Array(width * 4)

  for (let y = 0; y < height; y++) {
    if (offset + 4 > bytes.length) throw new Error('HDR ended inside scanline header')
    const b0 = bytes[offset]!
    const b1 = bytes[offset + 1]!
    const b2 = bytes[offset + 2]!
    const b3 = bytes[offset + 3]!

    if (width < 8 || width > 0x7fff || b0 !== 2 || b1 !== 2 || (b2 & 0x80) !== 0) {
      const dst = y * width * 4
      const remaining = width * height * 4 - dst
      if (offset + remaining > bytes.length) throw new Error('HDR ended inside flat pixel data')
      out.set(bytes.subarray(offset, offset + remaining), dst)
      return out
    }

    const line_width = (b2 << 8) | b3
    if (line_width !== width) throw new Error('HDR scanline width does not match resolution')
    offset += 4

    for (let channel = 0; channel < 4; channel++) {
      let x = 0
      while (x < width) {
        if (offset >= bytes.length) throw new Error('HDR ended inside RLE data')
        const code = bytes[offset++]!
        if (code > 128) {
          const count = code - 128
          if (count === 0 || x + count > width || offset >= bytes.length) throw new Error('HDR has invalid RLE run')
          const value = bytes[offset++]!
          scanline.fill(value, channel * width + x, channel * width + x + count)
          x += count
        } else {
          const count = code
          if (count === 0 || x + count > width || offset + count > bytes.length) throw new Error('HDR has invalid literal run')
          scanline.set(bytes.subarray(offset, offset + count), channel * width + x)
          offset += count
          x += count
        }
      }
    }

    const dst = y * width * 4
    for (let x = 0; x < width; x++) {
      out[dst + x * 4] = scanline[x]!
      out[dst + x * 4 + 1] = scanline[width + x]!
      out[dst + x * 4 + 2] = scanline[width * 2 + x]!
      out[dst + x * 4 + 3] = scanline[width * 3 + x]!
    }
  }

  return out
}
