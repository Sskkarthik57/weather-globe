// GPU wind particles.
//  - particle state (u, v, age, respawned) lives in a float texture, updated by ping-pong shader passes
//  - each frame particles are drawn as short line segments (old -> new position) into an
//    equirectangular "trail" texture that fades over time; the Earth shader samples it.
// Trails therefore stay attached to the ground while the camera moves (no screen-space smearing).
import * as THREE from 'three';
import { DATA_UV_GLSL } from './earth.js';

const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const COMMON = /* glsl */`
uniform sampler2D dataA, dataB;
uniform float dataMix;
${DATA_UV_GLSL}
vec2 windAt(vec2 p) {
  vec2 duv = gridUv(p, vec2(textureSize(dataA, 0)));
  return mix(texture(dataA, duv).rg, texture(dataB, duv).rg, dataMix); // m/s, x east, y north
}
float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
vec2 randomPos(vec2 seed) {
  float u = hash(seed);
  float lat = asin(2.0 * hash(seed + 7.31) - 1.0);       // area-weighted latitude
  return vec2(u, lat / 3.14159265 + 0.5);
}`;

const UPDATE_FRAG = /* glsl */`
uniform sampler2D stateTex;
uniform float dt, seed, speed, reset, dropRate;
varying vec2 vUv;
${COMMON}
void main() {
  vec4 s = texture(stateTex, vUv);
  vec2 sd = vUv + vec2(seed, seed * 1.618);
  if (reset > 0.5) { gl_FragColor = vec4(randomPos(sd), hash(sd + 3.7), 1.0); return; }
  vec2 p = s.xy;
  vec2 w = windAt(p);
  float coslat = max(cos((p.y - 0.5) * 3.14159265), 0.06);
  p.x = fract(p.x + w.x * speed * dt / coslat / 360.0);
  p.y += w.y * speed * dt / 180.0;
  float age = s.z + dt / (2.6 + 2.4 * hash(vUv * 3.1));
  float spd = length(w);
  float drop = dropRate * dt * (1.0 + 2.0 * smoothstep(1.5, 0.0, spd)); // recycle calm particles faster
  bool respawn = age > 1.0 || p.y < 0.01 || p.y > 0.99 || hash(sd + 11.0) < drop;
  gl_FragColor = respawn ? vec4(randomPos(sd + 5.0), 0.0, 1.0) : vec4(p, age, 0.0);
}`;

const LINE_VERT = /* glsl */`
uniform sampler2D stateOld, stateNew;
varying float vAlpha;
varying float vSpeed;
${COMMON}
void main() {
  vec2 ref = position.xy;
  vec4 o = texture(stateOld, ref);
  vec4 n = texture(stateNew, ref);
  vec2 p = position.z > 0.5 ? n.xy : o.xy;
  bool bad = n.w > 0.5 || abs(n.x - o.x) > 0.5;
  vec2 w = windAt(n.xy);
  vSpeed = length(w);
  vAlpha = smoothstep(0.0, 0.12, n.z) * (1.0 - smoothstep(0.75, 1.0, n.z)) * smoothstep(0.3, 2.5, vSpeed);
  gl_Position = bad ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const LINE_FRAG = /* glsl */`
uniform sampler2D rampTex;
uniform vec2 rampRange;
uniform float colorMode, opacity;
varying float vAlpha;
varying float vSpeed;
void main() {
  vec3 c = colorMode > 0.5
    ? texture(rampTex, vec2(clamp((vSpeed - rampRange.x) / (rampRange.y - rampRange.x), 0.0, 1.0), 0.5)).rgb
    : vec3(1.0);
  float a = vAlpha * opacity;
  gl_FragColor = vec4(c * a, a);
}`;

const FADE_FRAG = /* glsl */`
uniform float fade;
void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, fade); }`;

export class WindParticles {
  constructor(renderer, tier, rampTex, rampRange) {
    this.renderer = renderer;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadGeo = new THREE.PlaneGeometry(2, 2);
    this.shared = {
      dataA: { value: null }, dataB: { value: null }, dataMix: { value: 0 },
    };
    this.updateMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: UPDATE_FRAG, depthTest: false, depthWrite: false,
      uniforms: { ...this.shared, stateTex: { value: null }, dt: { value: 0 }, seed: { value: 0 }, speed: { value: 0.34 }, reset: { value: 1 }, dropRate: { value: 0.12 } },
    });
    this.fadeMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: FADE_FRAG, depthTest: false, depthWrite: false,
      uniforms: { fade: { value: 0.96 } }, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.SrcAlphaFactor,
    });
    this.lineMat = new THREE.ShaderMaterial({
      vertexShader: LINE_VERT, fragmentShader: LINE_FRAG, depthTest: false, depthWrite: false, transparent: true,
      uniforms: { ...this.shared, stateOld: { value: null }, stateNew: { value: null }, rampTex: { value: rampTex }, rampRange: { value: rampRange }, colorMode: { value: 1 }, opacity: { value: 0.9 } },
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.updateScene = new THREE.Scene();
    this.updateScene.add(this._quad(this.updateMat));
    this.trailScene = new THREE.Scene();
    this.fadeQuad = this._quad(this.fadeMat); this.fadeQuad.renderOrder = 0;
    this.trailScene.add(this.fadeQuad);
    this.build(tier);
  }

  _quad(mat) { const m = new THREE.Mesh(this.quadGeo, mat); m.frustumCulled = false; return m; }

  build(tier) {
    this.disposeTargets();
    const [w, h] = tier.particleTex;
    const opts = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false };
    this.stateA = new THREE.WebGLRenderTarget(w, h, opts);
    this.stateB = new THREE.WebGLRenderTarget(w, h, opts);
    const [tw, th] = tier.trailRes;
    this.trail = new THREE.WebGLRenderTarget(tw, th, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, wrapS: THREE.RepeatWrapping,
    });
    this.maxCount = w * h;
    const pos = new Float32Array(this.maxCount * 2 * 3);
    for (let i = 0; i < this.maxCount; i++) {
      const u = ((i % w) + 0.5) / w, v = (Math.floor(i / w) + 0.5) / h;
      pos.set([u, v, 0, u, v, 1], i * 6);
    }
    if (this.lines) { this.trailScene.remove(this.lines); this.lines.geometry.dispose(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.lines = new THREE.LineSegments(g, this.lineMat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 1;
    this.trailScene.add(this.lines);
    this.setCount(tier.particles);
    this.needsReset = true;
  }

  setCount(n) {
    this.count = Math.min(this.maxCount, Math.max(1, Math.round(n)));
    this.lines.geometry.setDrawRange(0, this.count * 2);
  }

  clearTrails() {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.trail);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.setRenderTarget(prev);
  }

  /** dt in seconds. */
  step(dt, timeSec) {
    const r = this.renderer;
    dt = Math.min(dt, 1 / 30);
    const u = this.updateMat.uniforms;
    u.dt.value = dt;
    u.seed.value = (timeSec * 0.6180339) % 1;
    if (this.needsReset) {
      u.reset.value = 1;
      u.stateTex.value = this.stateB.texture;
      r.setRenderTarget(this.stateA); r.render(this.updateScene, this.camera);
      u.reset.value = 0;
      this.needsReset = false;
      this.clearTrails();
    }
    u.stateTex.value = this.stateA.texture;
    r.setRenderTarget(this.stateB);
    r.render(this.updateScene, this.camera);

    this.fadeMat.uniforms.fade.value = Math.pow(0.962, dt * 60);
    this.lineMat.uniforms.stateOld.value = this.stateA.texture;
    this.lineMat.uniforms.stateNew.value = this.stateB.texture;
    r.setRenderTarget(this.trail);
    r.render(this.trailScene, this.camera);
    r.setRenderTarget(null);
    const t = this.stateA; this.stateA = this.stateB; this.stateB = t;
  }

  disposeTargets() {
    this.stateA?.dispose(); this.stateB?.dispose(); this.trail?.dispose();
  }
}
