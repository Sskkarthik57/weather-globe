// Earth sphere (single shader does basemap, day/night, glint, temperature + wind overlays),
// atmosphere shell and starfield.
import * as THREE from 'three';
import { TEMP_RAMP, AQI_RAMP, rampPixels } from './util.js';

export function makeRampTexture(ramp) {
  const t = new THREE.DataTexture(rampPixels(ramp), 256, 1, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

// Shared GLSL: sphere uv (u: lon -180..180, v: lat -90..90) -> uv in a global lat/lon grid texture
// whose first row is 90°N, first column 0°E, spanning 360° x 180° with `size` texels (e.g. 360x181).
export const DATA_UV_GLSL = /* glsl */`
vec2 gridUv(vec2 suv, vec2 size) {
  float lat = suv.y * 180.0 - 90.0;
  float lon = suv.x * 360.0 - 180.0;
  return vec2(lon / 360.0 + 0.5 / size.x, ((90.0 - lat) / 180.0 * (size.y - 1.0) + 0.5) / size.y);
}`;

// Smooth B-spline bicubic sampling using 4 bilinear taps (removes the 1° grid look when zoomed in)
const BICUBIC_GLSL = /* glsl */`
vec4 cubicW(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x, y = s.y - 4.0 * s.x, z = s.z - 4.0 * s.y + 6.0 * s.x;
  return vec4(x, y, z, 6.0 - x - y - z) / 6.0;
}
vec3 texBicubic(sampler2D t, vec2 uv) {
  vec2 size = vec2(textureSize(t, 0));
  uv = uv * size - 0.5;
  vec2 f = fract(uv); uv -= f;
  vec4 xc = cubicW(f.x), yc = cubicW(f.y);
  vec4 c = uv.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 o = (c + vec4(xc.yw, yc.yw) / s) / size.xxyy;
  vec3 s0 = texture(t, o.xz).rgb, s1 = texture(t, o.yz).rgb, s2 = texture(t, o.xw).rgb, s3 = texture(t, o.yw).rgb;
  float sx = s.x / (s.x + s.y), sy = s.z / (s.z + s.w);
  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}`;

const EARTH_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vN;
varying vec3 vP;
void main() {
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const EARTH_FRAG = /* glsl */`
uniform sampler2D dayTex, nightTex, waterTex, dataA, dataB, rampTex, trailTex, aqA, aqB, aqRamp;
uniform vec3 sunDir;
uniform float dataMix, tempOn, tempOpacity, windOn, atmo, hasData, aqOn, aqMix, hasAq;
uniform vec2 tRange, rampRange;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vP;
${DATA_UV_GLSL}
${BICUBIC_GLSL}
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vP);
  float NdL = dot(N, sunDir);
  float dayAmt = smoothstep(-0.10, 0.16, NdL);
  float lambert = max(NdL, 0.0);

  vec3 day = texture(dayTex, vUv).rgb;
  vec3 night = texture(nightTex, vUv).rgb;
  vec3 col = day * (0.035 + 1.25 * pow(lambert, 0.75));
  vec3 lights = pow(night, vec3(1.4)) * vec3(1.0, 0.78, 0.48) * 1.8;
  col += lights * (1.0 - dayAmt);

  float w = texture(waterTex, vUv).r;
  if (atmo > 0.5) {
    vec3 H = normalize(sunDir + V);
    float spec = pow(max(dot(N, H), 0.0), 70.0) * w * smoothstep(0.0, 0.2, NdL);
    col += vec3(1.0, 0.93, 0.82) * spec * 0.55;
  }

  if (aqOn > 0.5 && hasAq > 0.5) {
    vec2 auv = gridUv(vUv, vec2(textureSize(aqA, 0)));
    float aqi = mix(texBicubic(aqA, auv).r, texBicubic(aqB, auv).r, aqMix) * 500.0;
    // AQI -> equal-width category position (0..1), matching aqiToX() in util.js
    float x = aqi <= 50.0 ? aqi / 50.0 : aqi <= 100.0 ? 1.0 + (aqi - 50.0) / 50.0 : aqi <= 150.0 ? 2.0 + (aqi - 100.0) / 50.0
            : aqi <= 200.0 ? 3.0 + (aqi - 150.0) / 50.0 : aqi <= 300.0 ? 4.0 + (aqi - 200.0) / 100.0 : 5.0 + (aqi - 300.0) / 200.0;
    vec3 ac = texture(aqRamp, vec2(clamp(x / 6.0, 0.0, 1.0), 0.5)).rgb;
    float lit = mix(0.26, 1.0, dayAmt);
    // clean air stays a light tint so the Earth shows through; pollution is vivid; oceans de-emphasised
    float alpha = mix(0.32, 0.86, smoothstep(20.0, 90.0, aqi)) * mix(1.0, 0.6, w);
    col = mix(col, ac * lit, alpha);
    col += lights * (1.0 - dayAmt) * 0.45;
  }

  if (hasData > 0.5) {
    vec2 duv = gridUv(vUv, vec2(textureSize(dataA, 0)));
    if (tempOn > 0.5) {
      float d = mix(texBicubic(dataA, duv).r, texBicubic(dataB, duv).r, dataMix);
      float tC = mix(tRange.x, tRange.y, d);
      float x = clamp((tC - rampRange.x) / (rampRange.y - rampRange.x), 0.0, 1.0);
      vec3 tc = texture(rampTex, vec2(x, 0.5)).rgb;
      float lit = mix(0.26, 1.0, dayAmt);
      col = mix(col, tc * lit, tempOpacity);
      col += lights * (1.0 - dayAmt) * 0.45;   // cities still glow through at night
    }
    if (windOn > 0.5) {
      vec4 tr = texture(trailTex, vUv);
      float lit = mix(0.55, 1.0, dayAmt);
      col = col * (1.0 - tr.a) + tr.rgb * lit;
    }
  }

  // limb haze on the surface
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  float sunSide = atmo > 0.5 ? (0.2 + 0.8 * smoothstep(-0.25, 0.4, NdL)) : 0.6;
  col += vec3(0.32, 0.58, 1.0) * fres * sunSide * 0.55;

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export class Earth {
  constructor(tier) {
    this.uniforms = {
      dayTex: { value: null }, nightTex: { value: null }, waterTex: { value: null },
      dataA: { value: null }, dataB: { value: null }, dataMix: { value: 0 },
      rampTex: { value: makeRampTexture(TEMP_RAMP) }, rampRange: { value: new THREE.Vector2(TEMP_RAMP.min, TEMP_RAMP.max) },
      trailTex: { value: null }, sunDir: { value: new THREE.Vector3(1, 0, 0) },
      tRange: { value: new THREE.Vector2(-50, 50) },
      tempOn: { value: 1 }, tempOpacity: { value: 0.82 }, windOn: { value: 0 }, atmo: { value: tier.atmosphere }, hasData: { value: 0 },
      aqA: { value: null }, aqB: { value: null }, aqMix: { value: 0 }, aqOn: { value: 0 }, hasAq: { value: 0 },
      aqRamp: { value: makeRampTexture(AQI_RAMP) },
    };
    this.material = new THREE.ShaderMaterial({ vertexShader: EARTH_VERT, fragmentShader: EARTH_FRAG, uniforms: this.uniforms });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, tier.segments, tier.segments / 2), this.material);
    this.segments = tier.segments;
  }
  setTier(tier) {
    this.uniforms.atmo.value = tier.atmosphere;
    if (tier.segments !== this.segments) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = new THREE.SphereGeometry(1, tier.segments, tier.segments / 2);
      this.segments = tier.segments;
    }
  }
}

// ---------------------------------------------------------------- atmosphere
const ATMO_THICK = 0.05;
const ATMO_VERT = /* glsl */`
varying vec3 vP;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const ATMO_FRAG = /* glsl */`
uniform vec3 sunDir;
uniform float atmo;
varying vec3 vP;
void main() {
  vec3 D = normalize(vP - cameraPosition);
  float tca = dot(-cameraPosition, D);
  vec3 closest = cameraPosition + D * tca;
  float b = length(closest);                 // closest approach of view ray to Earth centre
  float h = clamp((b - 1.0) / ${ATMO_THICK.toFixed(3)}, 0.0, 1.0);
  float glow = pow(1.0 - h, 3.2) * smoothstep(0.996, 1.003, b);
  float sunF = 0.5;
  vec3 c = vec3(0.26, 0.52, 1.0);
  if (atmo > 0.5) {
    float s = dot(normalize(closest), sunDir);
    sunF = 0.05 + 0.95 * smoothstep(-0.25, 0.35, s);
    float dusk = exp(-pow(s / 0.12, 2.0));            // thin warm band at the terminator only
    c = mix(c, vec3(1.0, 0.5, 0.28), dusk * 0.6);
  }
  gl_FragColor = vec4(c * glow * sunF * 1.1, 1.0);
  #include <colorspace_fragment>
}`;

export class Atmosphere {
  constructor(earthUniforms) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG,
      uniforms: { sunDir: earthUniforms.sunDir, atmo: earthUniforms.atmo },
      side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1 + ATMO_THICK, 96, 48), this.material);
  }
}

// ---------------------------------------------------------------- stars
const STAR_VERT = /* glsl */`
attribute float size;
attribute vec3 tint;
uniform float pr;
varying vec3 vTint;
void main() {
  vTint = tint;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * pr;
}`;
const STAR_FRAG = /* glsl */`
varying vec3 vTint;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(c));
  gl_FragColor = vec4(vTint * a, 1.0);
}`;

export function makeStars(count, pixelRatio) {
  const pos = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const tint = new Float32Array(count * 3);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < count; i++) {
    const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    pos.set([r * Math.cos(th) * 900, u * 900, r * Math.sin(th) * 900], i * 3);
    const m = Math.pow(rnd(), 6);
    size[i] = 0.8 + m * 2.6;
    const b = 0.25 + m * 0.75 + rnd() * 0.15;
    const warm = rnd();
    tint.set(warm < 0.15 ? [b, b * 0.85, b * 0.7] : warm > 0.8 ? [b * 0.8, b * 0.88, b] : [b, b, b], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('size', new THREE.BufferAttribute(size, 1));
  g.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
  const m = new THREE.ShaderMaterial({
    vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, uniforms: { pr: { value: pixelRatio } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  return pts;
}
