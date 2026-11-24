// Rivers layer: Natural Earth river lines drawn as anti-aliased screen-space ribbons (mitred joins)
// with an animated downstream flow, level-of-detail fading, hover/click picking, and highlighting of
// a selected river with its tributaries, the river it drains into, its source, mouth and dams.
import * as THREE from 'three';
import { latLonToVec3, el, DEG, clamp } from './util.js';

const BASE = import.meta.env.BASE_URL + 'rivers/';
const R = 1.0015;               // lines float just above the surface
const EARTH_KM = 6371;
const STATE_W = 1024;           // width of the per-river state texture
export const STATE = { none: 0, trib: 1, selected: 2, mouth: 3 };
export const RIVER_COLORS = { base: '#5aa9ff', selected: '#a6ecff', trib: '#5ff0b0', mouth: '#bda6ff', source: '#ffcf70', dam: '#ff7d8f' };

/** Rank-based zoom threshold (same formula as the shader): small rivers appear as you zoom in. */
export const lodVisible = (rank, dist) => rank <= 3 || dist < 8.6 - 0.7 * rank + 0.2;

const VERT = /* glsl */`
attribute vec3 iPrev, iA, iB, iNext;
attribute vec4 iInfo;                 // x,y: distance (km) from the start of the line at A and B; z: river id; w: rank
uniform vec2 res;
uniform float pr, camDist, hovId, hasSel, glow;
uniform vec3 sunDir, cBase, cSel, cTrib, cMouth;
uniform sampler2D stateTex;
varying float vAcross, vHalf, vD, vAlpha, vPulse;
varying vec3 vCol;

vec2 scr(vec4 c) { return c.xy / c.w * 0.5 * res; }
void main() {
  float rid = iInfo.z, rank = iInfo.w;
  float state = floor(texelFetch(stateTex, ivec2(int(mod(rid, ${STATE_W}.0)), int(rid / ${STATE_W}.0)), 0).r * 255.0 + 0.5);
  bool hov = abs(rid - hovId) < 0.5;
  bool atB = position.x > 0.5;

  mat4 vp = projectionMatrix * viewMatrix;
  vec4 cP = vp * vec4(iPrev, 1.0), cA = vp * vec4(iA, 1.0), cB = vp * vec4(iB, 1.0), cN = vp * vec4(iNext, 1.0);
  vec2 sP = scr(cP), sA = scr(cA), sB = scr(cB), sN = scr(cN);
  vec2 d = sB - sA; float dl = length(d);
  vec2 dir = dl > 1e-4 ? d / dl : vec2(1.0, 0.0);
  vec2 o = atB ? sN - sB : sA - sP; float ol = length(o);
  vec2 dir2 = ol > 1e-4 ? o / ol : dir;
  vec2 t = dir + dir2; float tl = length(t);
  t = tl > 1e-4 ? t / tl : dir;
  vec2 n = vec2(-dir.y, dir.x), m = vec2(-t.y, t.x);
  float ml = 1.0 / max(dot(m, n), 0.5);           // mitre length, capped at 2x for sharp bends

  float th = rank <= 3.0 ? 99.0 : 8.6 - 0.7 * rank;
  float lod = 1.0 - smoothstep(th - 0.35, th + 0.35, camDist);
  float w = rank <= 2.0 ? 2.1 : rank <= 4.0 ? 1.7 : rank <= 6.0 ? 1.35 : 1.05;
  w *= mix(1.0, 1.6, clamp((2.6 - camDist) / 1.4, 0.0, 1.0));
  vec3 col = cBase;
  float a = 0.88, pulse = 0.5;
  if (state == 2.0) { col = cSel; w += 1.8; lod = 1.0; a = 1.0; pulse = 1.0; }
  else if (state == 1.0) { col = cTrib; w += 0.8; lod = max(lod, 0.95); a = 1.0; pulse = 0.8; }
  else if (state == 3.0) { col = cMouth; w += 0.8; lod = max(lod, 0.95); a = 1.0; pulse = 0.8; }
  else if (hasSel > 0.5) { a = 0.28; pulse = 0.2; }
  if (hov) { col = mix(col, vec3(1.0), 0.4); w += 0.9; lod = max(lod, 1.0); a = 1.0; pulse = max(pulse, 0.8); }
  if (glow > 0.5) w = state == 2.0 ? w * 3.0 + 6.0 : state > 0.5 ? w * 2.0 + 3.0 : hov ? w * 2.5 + 4.0 : 0.0;

  // fade at the horizon (the globe hides the far side; lines don't write depth)
  vec3 P = atB ? iB : iA;
  vec3 Pn = normalize(P);
  float fa = dot(normalize(iA), normalize(cameraPosition - iA));
  float fb = dot(normalize(iB), normalize(cameraPosition - iB));
  float facing = atB ? fb : fa;
  float lit = mix(0.6, 1.0, smoothstep(-0.12, 0.2, dot(Pn, sunDir)));
  vAlpha = a * lod * smoothstep(0.0, 0.12, facing);
  vPulse = pulse;
  float hw = 0.5 * w * pr;
  vHalf = hw;
  float ext = hw + pr;                              // 1 px fringe for anti-aliasing
  vAcross = position.y * ext;
  vD = atB ? iInfo.y : iInfo.x;
  vCol = col * lit;
  // cull whole segments (both ends together, so quads never stretch)
  if (a * lod < 0.004 || w <= 0.0 || max(fa, fb) < -0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 c = atB ? cB : cA;
  c.xy += m * (position.y * ext * ml) / (0.5 * res) * c.w;
  gl_Position = c;
}`;

const FRAG = /* glsl */`
uniform float flowS0, flowMix, flowF, flowAmt, glow;
varying float vAcross, vHalf, vD, vAlpha, vPulse;
varying vec3 vCol;
void main() {
  float x = abs(vAcross);
  if (glow > 0.5) {
    // soft coloured halo (normal blending, so it never washes out to white on bright maps)
    float g = exp(-pow(x / max(vHalf, 1.0) * 1.8, 2.0));
    gl_FragColor = vec4(vCol, g * vAlpha * 0.42);
    #include <colorspace_fragment>
    return;
  }
  float cov = clamp(vHalf - x + 0.5, 0.0, 1.0);
  // flowing pulses: two octaves of spacing (powers of two, in km) blended so zooming never pops;
  // the head of each pulse points downstream because distance grows from source to mouth
  float p0 = fract((vD - flowF) / flowS0), p1 = fract((vD - flowF) / (flowS0 * 2.0));
  p0 *= p0; p0 *= p0 * p0; p1 *= p1; p1 *= p1 * p1;
  float pulse = mix(p0, p1, flowMix) * flowAmt * vPulse;
  vec3 col = vCol * (0.82 + 0.9 * pulse) + vec3(0.25) * pulse * pulse;
  gl_FragColor = vec4(col, vAlpha * cov * (0.78 + 0.22 * pulse));
  #include <colorspace_fragment>
}`;

function decode(enc, q) {
  const out = new Float32Array(enc.length);
  let x = 0, y = 0;
  for (let k = 0; k < enc.length; k += 2) {
    x += enc[k]; y += enc[k + 1];
    out[k] = x / q; out[k + 1] = y / q;
  }
  return out;
}

export class Rivers {
  constructor(markerRoot, { sunDir, onMarker }) {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.markerRoot = markerRoot;
    this.onMarker = onMarker;
    this.status = 'idle';
    this.rivers = [];
    this.byQ = new Map();
    this.details = null;
    this.selected = -1;
    this.hovered = -1;
    this.markers = [];
    this.flowF = 0;
    this._v = new THREE.Vector3();
    const C = (h) => new THREE.Color(h);
    this.uniforms = {
      res: { value: new THREE.Vector2(1, 1) }, pr: { value: 1 }, camDist: { value: 3 }, hovId: { value: -1 }, hasSel: { value: 0 },
      sunDir, stateTex: { value: null }, glow: { value: 0 },
      cBase: { value: C(RIVER_COLORS.base) }, cSel: { value: C(RIVER_COLORS.selected) }, cTrib: { value: C(RIVER_COLORS.trib) }, cMouth: { value: C(RIVER_COLORS.mouth) },
      flowS0: { value: 64 }, flowMix: { value: 0 }, flowF: { value: 0 }, flowAmt: { value: 1 },
    };
  }

  load() {
    if (!this._loading) {
      this.status = 'loading';
      this._loading = fetch(BASE + 'rivers.json')
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then((j) => { this._build(j); this.status = 'ok'; })
        .catch((e) => { this.status = 'error'; this.error = e.message; throw e; });
    }
    return this._loading;
  }

  loadDetails() {
    if (!this._details) {
      this._details = fetch(BASE + 'details.json')
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then((j) => { this.details = j; return j; });
      this._details.catch(() => { this._details = null; }); // allow a retry on the next click
    }
    return this._details;
  }

  _build(j) {
    const Q = j.meta.quant;
    let nseg = 0;
    this.rivers = j.rivers.map((r, i) => {
      const parts = r.p.map((enc) => decode(enc, Q));
      for (const p of parts) nseg += p.length / 2 - 1;
      const rv = { i, q: r.q, name: r.n, rank: r.r, alt: r.a || [], parts, search: [r.n, ...(r.a || [])].filter(Boolean).map((s) => s.toLowerCase()) };
      if (r.q) this.byQ.set(r.q, rv);
      return rv;
    });
    const prev = new Float32Array(nseg * 3), A = new Float32Array(nseg * 3), B = new Float32Array(nseg * 3), next = new Float32Array(nseg * 3);
    const info = new Float32Array(nseg * 4);
    this.segRiver = new Uint16Array(nseg);
    const grid = new Map();
    this.grid = grid;
    const v = this._v, pa = new THREE.Vector3(), pb = new THREE.Vector3();
    let s = 0;
    for (const rv of this.rivers) {
      const centre = new THREE.Vector3();
      for (const ll of rv.parts) {
        const n = ll.length / 2;
        const P = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) {
          latLonToVec3(ll[2 * k + 1], ll[2 * k], R, v);
          P[3 * k] = v.x; P[3 * k + 1] = v.y; P[3 * k + 2] = v.z;
          centre.add(v);
        }
        let cum = 0;
        for (let k = 0; k < n - 1; k++, s++) {
          const a3 = 3 * k, b3 = 3 * (k + 1);
          for (let c = 0; c < 3; c++) {
            A[3 * s + c] = P[a3 + c];
            B[3 * s + c] = P[b3 + c];
            prev[3 * s + c] = k > 0 ? P[a3 - 3 + c] : 2 * P[a3 + c] - P[b3 + c];
            next[3 * s + c] = k + 2 < n ? P[b3 + 3 + c] : 2 * P[b3 + c] - P[a3 + c];
          }
          pa.fromArray(P, a3); pb.fromArray(P, b3);
          const d = pa.angleTo(pb) * EARTH_KM;
          info.set([cum, cum + d, rv.i, rv.rank], 4 * s);
          cum += d;
          this.segRiver[s] = rv.i;
          // picking grid (1° cells)
          const lo0 = Math.floor(Math.min(ll[2 * k], ll[2 * k + 2])), lo1 = Math.floor(Math.max(ll[2 * k], ll[2 * k + 2]));
          const la0 = Math.floor(Math.min(ll[2 * k + 1], ll[2 * k + 3])), la1 = Math.floor(Math.max(ll[2 * k + 1], ll[2 * k + 3]));
          if (lo1 - lo0 > 180) continue; // antimeridian-spanning piece: skip for picking
          for (let la = la0; la <= la1; la++) for (let lo = lo0; lo <= lo1; lo++) {
            const key = (la + 90) * 360 + (lo + 180);
            let cell = grid.get(key);
            if (!cell) grid.set(key, (cell = []));
            cell.push(s);
          }
        }
      }
      // centre and angular radius, for framing the river with the camera
      centre.normalize();
      let maxAng = 0;
      for (const ll of rv.parts) for (let k = 0; k < ll.length; k += 2) {
        latLonToVec3(ll[k + 1], ll[k], 1, v);
        maxAng = Math.max(maxAng, centre.angleTo(v));
      }
      rv.centre = centre;
      rv.radius = maxAng;
    }
    this.A = A; this.B = B;
    this.nseg = nseg;

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0], 3));
    geo.setIndex([0, 2, 1, 2, 3, 1]);
    geo.setAttribute('iPrev', new THREE.InstancedBufferAttribute(prev, 3));
    geo.setAttribute('iA', new THREE.InstancedBufferAttribute(A, 3));
    geo.setAttribute('iB', new THREE.InstancedBufferAttribute(B, 3));
    geo.setAttribute('iNext', new THREE.InstancedBufferAttribute(next, 3));
    geo.setAttribute('iInfo', new THREE.InstancedBufferAttribute(info, 4));
    geo.instanceCount = nseg;

    const rows = Math.max(1, Math.ceil(this.rivers.length / STATE_W));
    this.state = new Uint8Array(STATE_W * rows);
    const tex = new THREE.DataTexture(this.state, STATE_W, rows, THREE.RedFormat, THREE.UnsignedByteType);
    tex.needsUpdate = true;
    this.uniforms.stateTex.value = tex;

    const mk = (glow) => {
      const u = { ...this.uniforms, glow: { value: glow } };
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG, uniforms: u, transparent: true, depthTest: false, depthWrite: false,
        blending: THREE.NormalBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = glow ? 2 : 3;
      return mesh;
    };
    this.glowMesh = mk(1);
    this.lineMesh = mk(0);
    this.group.add(this.glowMesh, this.lineMesh);
  }

  setVisible(v) {
    this.group.visible = v && this.status === 'ok';
    if (!v) for (const m of this.markers) { m.el.hidden = true; m.shown = false; }
  }

  setResolution(wPx, hPx, pr) {
    this.uniforms.res.value.set(wPx, hPx);
    this.uniforms.pr.value = pr;
  }

  /** Per frame: zoom-dependent flow spacing (so pulses look the same size at any zoom) and flow offset. */
  step(dtSec, camDist, camera, heightCss, animate) {
    const u = this.uniforms;
    u.camDist.value = camDist;
    const kmPerPx = ((camDist - 1) * 2 * Math.tan((camera.fov * DEG) / 2) / Math.max(1, heightCss)) * EARTH_KM;
    const level = Math.log2(Math.max(1, 70 * kmPerPx));
    const s0 = 2 ** Math.floor(level);
    u.flowS0.value = s0;
    u.flowMix.value = level - Math.floor(level);
    if (animate) this.flowF = (this.flowF + dtSec * 34 * kmPerPx) % 16384; // 34 px/s; wrap keeps every power-of-two spacing in phase
    u.flowF.value = this.flowF;
    u.flowAmt.value = animate ? 1 : 0.35;
  }

  /** Nearest visible named river within tolRad (radians) of the point, or -1. */
  pick(lat, lon, tolRad, camDist) {
    if (this.status !== 'ok') return -1;
    const p = latLonToVec3(lat, lon, 1, this._v);
    const tolDeg = tolRad / DEG;
    const lonTol = tolDeg / Math.max(0.15, Math.cos(lat * DEG));
    let best = -1, bestD = tolRad;
    const A = this.A, B = this.B;
    const seen = new Set();
    for (let la = Math.floor(lat - tolDeg); la <= Math.floor(lat + tolDeg); la++) {
      for (let lo = Math.floor(lon - lonTol); lo <= Math.floor(lon + lonTol); lo++) {
        const wl = ((lo + 180) % 360 + 360) % 360 - 180;
        const cell = this.grid.get((la + 90) * 360 + (wl + 180));
        if (!cell) continue;
        for (const s of cell) {
          if (seen.has(s)) continue;
          seen.add(s);
          const rv = this.rivers[this.segRiver[s]];
          if (!rv.name) continue;
          const st = this.state[rv.i];
          if (!st && !lodVisible(rv.rank, camDist)) continue;
          // point-to-segment distance on the unit sphere (segments are short, chord is fine)
          const ax = A[3 * s] / R, ay = A[3 * s + 1] / R, az = A[3 * s + 2] / R;
          const bx = B[3 * s] / R - ax, by = B[3 * s + 1] / R - ay, bz = B[3 * s + 2] / R - az;
          const px = p.x - ax, py = p.y - ay, pz = p.z - az;
          const bb = bx * bx + by * by + bz * bz;
          const t = bb > 0 ? clamp((px * bx + py * by + pz * bz) / bb, 0, 1) : 0;
          let d = Math.hypot(px - t * bx, py - t * by, pz - t * bz);
          if (st) d *= 0.7; // favour highlighted rivers where lines are close together
          if (d < bestD) { bestD = d; best = rv.i; }
        }
      }
    }
    return best;
  }

  setHover(i) {
    if (i === this.hovered) return false;
    this.hovered = i;
    this.uniforms.hovId.value = i;
    return true;
  }

  /** Highlight river i, its tributaries (that are drawn) and the river it drains into. Returns its details. */
  select(i) {
    this.state.fill(0);
    this.selected = i;
    this.uniforms.hasSel.value = i >= 0 ? 1 : 0;
    this._clearMarkers();
    const rv = this.rivers[i];
    const d = rv?.q && this.details ? this.details[rv.q] : null;
    if (rv) {
      for (const t of d?.tribs || []) { const tr = this.byQ.get(t.q); if (tr) this.state[tr.i] = STATE.trib; }
      for (const m of d?.mouth || []) { const mr = this.byQ.get(m.q); if (mr) this.state[mr.i] = STATE.mouth; }
      this.state[i] = STATE.selected;
      if (d) this._buildMarkers(rv, d);
    }
    this.uniforms.stateTex.value.needsUpdate = true;
    return d;
  }

  clearSelection() { if (this.selected >= 0 || this.markers.length) this.select(-1); }

  /** Where the river starts and ends, preferring Wikidata's named source (mountain, glacier, lake). */
  ends(rv, d) {
    const first = rv.parts.reduce((a, b) => (b.length > a.length ? b : a));
    const origin = d?.origin?.find((o) => o.pt);
    const src = origin?.pt || d?.srcPt || [first[0], first[1]];
    const mouth = d?.mouthPt || d?.lineEnd || [first[first.length - 2], first[first.length - 1]];
    return { src, mouth };
  }

  _buildMarkers(rv, d) {
    const { src, mouth } = this.ends(rv, d);
    const srcName = d.origin?.[0]?.name;
    const mouthName = d.mouth?.[0]?.name;
    for (const t of d.tribs || []) {
      if (t.pt && !this.byQ.has(t.q)) this._marker('trib', t.pt, t.name, { kind: 'trib', item: t });
    }
    (d.dams || []).forEach((dam, k) => { if (dam.pt) this._marker('dam', dam.pt, dam.name, { kind: 'dam', item: dam, index: k }); });
    this._marker('mouth', mouth, mouthName ? `Mouth · ${mouthName}` : 'Mouth', { kind: 'mouth' });
    this._marker('source', src, srcName ? `Source · ${srcName}` : 'Source', { kind: 'source' });
  }

  _marker(type, [lon, lat], label, payload) {
    const icons = {
      source: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19l6.5-11 3.5 6 2-3 6 8z"/></svg>',
      mouth: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/></svg>',
      dam: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14l-3 14H8z"/><path d="M8 10h8M9 14h6"/></svg>',
      trib: '',
    };
    const btn = el('button', {
      class: `marker rv-marker rv-${type}`, 'aria-label': label, title: label,
      onclick: (e) => { e.stopPropagation(); this.onMarker?.(payload); },
    });
    btn.innerHTML = icons[type];
    if (type === 'source' || type === 'mouth') btn.append(el('span', { class: 'rv-label', text: label }));
    else btn.append(el('span', { class: 'rv-label rv-label-hover', text: label }));
    btn.tabIndex = -1;
    btn.hidden = true;
    this.markerRoot.append(btn);
    const m = { el: btn, pos: latLonToVec3(lat, lon, 1, new THREE.Vector3()), shown: false, payload };
    this.markers.push(m);
    return m;
  }

  /** Pulse the marker of dam k (after the user picks it in the panel). */
  flashDam(k) {
    for (const m of this.markers) {
      const on = m.payload.kind === 'dam' && m.payload.index === k;
      m.el.classList.toggle('active', on);
    }
  }

  _clearMarkers() {
    for (const m of this.markers) m.el.remove();
    this.markers = [];
  }

  updateMarkers(camera, w, h) {
    if (!this.group.visible) return;
    for (const m of this.markers) {
      const visible = m.pos.dot(camera.position) > 1.01;
      if (visible) {
        this._v.copy(m.pos).project(camera);
        m.el.style.transform = `translate(${((this._v.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-this._v.y * 0.5 + 0.5) * h).toFixed(1)}px)`;
      }
      if (visible !== m.shown) { m.el.hidden = !visible; m.shown = visible; }
    }
  }

  /** Local name search (instant, no network): best matches first. */
  search(q, max = 4) {
    if (this.status !== 'ok') return [];
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    const scored = [];
    for (const rv of this.rivers) {
      if (!rv.name) continue;
      let best = 9;
      for (const n of rv.search) {
        const bare = n.replace(/^(river|rio|río|rivière|fleuve)\s+/, '').replace(/\s+(river|rivier|fluss)$/, '');
        if (n === s || bare === s) best = 0;
        else if (n.startsWith(s) || bare.startsWith(s)) best = Math.min(best, 1);
        else if (n.includes(' ' + s)) best = Math.min(best, 2);
      }
      if (best < 9) scored.push([best, rv.rank, rv]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return scored.slice(0, max).map(([, , rv]) => rv);
  }
}
