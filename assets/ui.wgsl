struct vs_in {
  @location(0) pos : vec2f,
  @location(1) uv  : vec2f,
  // Packed from C as little-endian RGBA8; consumed as normalized floats.
  @location(2) col : vec4f,
}

struct vs_out {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
  @location(1) col : vec4f,
}

@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var<uniform> screen : vec2f;

@vertex fn vs_main(in: vs_in) -> vs_out {
  var o: vs_out;

  // pixel -> NDC (top-left origin)
  let ndc = vec2f(
    (in.pos.x / screen.x) * 2.0 - 1.0,
    1.0 - (in.pos.y / screen.y) * 2.0
  );

  o.pos = vec4f(ndc, 0.0, 1.0);
  o.uv = in.uv;
  o.col = in.col;
  return o;
}

fn median(r: f32, g: f32, b: f32) -> f32 {
  return max(min(r, g), min(max(r, g), b));
}

fn screen_px_range(uv: vec2f) -> f32 {
  let tex_size = vec2f(textureDimensions(tex));
  let unit_range = vec2f(5.0) / tex_size;
  let screen_texel = max(fwidth(uv), vec2f(1e-6));
  return max(0.5 * dot(unit_range, vec2f(1.0) / screen_texel), 1.0);
}

@fragment fn fs_sdf(in: vs_out) -> @location(0) vec4f {
  let s = textureSample(tex, samp, in.uv);
  let sd = median(s.r, s.g, s.b);
  let px_dist = (sd - 0.5) * screen_px_range(in.uv);
  let aa = fwidth(px_dist);
  let opacity = smoothstep(-aa, aa, px_dist);

  return vec4f(in.col.rgb, in.col.a * opacity);
}

@fragment fn fs_image(in: vs_out) -> @location(0) vec4f {
  return textureSample(tex, samp, in.uv) * in.col;
}

fn aces(x: vec3f) -> vec3f {
  // ACES fitted curve (Stephen Hill)
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

@fragment fn fs_scene(in: vs_out) -> @location(0) vec4f {
  let hdr = textureSample(tex, samp, in.uv).rgb;
  let mapped = aces(hdr);
  let srgb = pow(mapped, vec3f(1.0 / 2.2));
  return vec4f(srgb, 1.0);
}
