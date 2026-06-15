enable f16;

struct vs_in {
  @location(0) pos : vec2f,
  @location(1) uv  : vec2f,
  // Packed from C as little-endian RGBA8; consumed as normalized floats.
  @location(2) col : vec4f,
  // x = atlas MSDF pixel range, y = weight in screen px, z = edge softness.
  @location(3) params : vec4f,
}

struct vs_out {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
  // Vertex colour is bounded to [0,1], so carry it as half across the
  // interpolator and into the fragment blend math.
  @location(1) col : vec4<f16>,
  @location(2) params : vec4f,
}

@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var<uniform> screen : vec2f;

@vertex fn vs_main(in: vs_in) -> vs_out {
  var o: vs_out;

  // pixel -> NDC (top-left origin). Kept in f32: pixel coordinates can exceed
  // the integer-exact range of f16 (2048) on large surfaces.
  let ndc = vec2f(
    (in.pos.x / screen.x) * 2.0 - 1.0,
    1.0 - (in.pos.y / screen.y) * 2.0
  );

  o.pos = vec4f(ndc, 0.0, 1.0);
  o.uv = in.uv;
  o.col = vec4<f16>(in.col);
  o.params = in.params;
  return o;
}

fn median(r: f16, g: f16, b: f16) -> f16 {
  return max(min(r, g), min(max(r, g), b));
}

fn screen_px_range(uv: vec2f) -> f32 {
  // f32: fwidth derivatives can be tiny, so 1/screen_texel may overflow f16.
  let tex_size = vec2f(textureDimensions(tex));
  let unit_range = vec2f(5.0) / tex_size;
  let screen_texel = max(fwidth(uv), vec2f(1e-6));
  return max(0.5 * dot(unit_range, vec2f(1.0) / screen_texel), 1.0);
}

fn screen_px_range_var(uv: vec2f, msdf_range: f32) -> f32 {
  // `msdf_range` is the atlas distance range used when the font texture was
  // generated. The legacy path uses 5.0; variable text carries it per glyph.
  let tex_size = vec2f(textureDimensions(tex));
  let unit_range = vec2f(max(msdf_range, 0.5)) / tex_size;
  let screen_texel = max(fwidth(uv), vec2f(1e-6));
  return max(0.5 * dot(unit_range, vec2f(1.0) / screen_texel), 1.0);
}

@fragment fn fs_sdf(in: vs_out) -> @location(0) vec4f {
  let s = textureSample(tex, samp, in.uv);
  let sd = median(f16(s.r), f16(s.g), f16(s.b));
  let px_dist = (sd - 0.5) * f16(screen_px_range(in.uv));
  // 1-pixel linear ramp — sharpest non-aliasing edge (msdfgen reference).
  let opacity = clamp(px_dist + 0.5, 0.0, 1.0);

  return vec4f(vec3f(in.col.rgb), f32(in.col.a * opacity));
}

@fragment fn fs_msdf_var(in: vs_out) -> @location(0) vec4f {
  let s = textureSample(tex, samp, in.uv);
  let sd = median(f16(s.r), f16(s.g), f16(s.b));
  let range = screen_px_range_var(in.uv, in.params.x);
  let weight = f16(in.params.y);
  let softness = f16(max(in.params.z, 1.0));
  let px_dist = (sd - 0.5) * f16(range) + weight;
  let opacity = clamp(px_dist / softness + 0.5, 0.0, 1.0);

  return vec4f(vec3f(in.col.rgb), f32(in.col.a * opacity));
}

@fragment fn fs_image(in: vs_out) -> @location(0) vec4f {
  let texel = vec4<f16>(textureSample(tex, samp, in.uv));
  return vec4f(texel * in.col);
}

fn aces(x: vec3<f16>) -> vec3<f16> {
  // ACES fitted curve (Stephen Hill)
  let a: f16 = 2.51; let b: f16 = 0.03; let c: f16 = 2.43; let d: f16 = 0.59; let e: f16 = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f16>(0.0), vec3<f16>(1.0));
}

@fragment fn fs_scene(in: vs_out) -> @location(0) vec4f {
  let hdr = vec3<f16>(textureSample(tex, samp, in.uv).rgb);
  let mapped = aces(hdr);
  let srgb = pow(mapped, vec3<f16>(1.0 / 2.2));
  return vec4f(vec3f(srgb), 1.0);
}
