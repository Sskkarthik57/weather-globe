// Tropical cyclones (GDACS): 3D tracks (observed solid, forecast dashed), HTML markers, storm list.
import * as THREE from 'three';
import { CYCLONE_COLORS, CYCLONE_NAMES, latLonToVec3, el, fmtSpeedKmh, DEG } from './util.js';

const BASE = import.meta.env.BASE_URL + 'data/';
const R = 1.004;
const STATUS = { HU: 'Hurricane / typhoon', TY: 'Typhoon', TS: 'Tropical storm', TD: 'Tropical depression', ST: 'Super typhoon', EX: 'Extratropical', LO: 'Low' };

const TUBE_VERT = /* glsl */`
varying float vS;
void main() { vS = uv.x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const TUBE_FRAG = /* glsl */`
uniform vec3 color;
uniform float dashed, len, opacity;
varying float vS;
void main() {
  if (dashed > 0.5 && fract(vS * len / 0.018) > 0.55) discard;
  gl_FragColor = vec4(color, opacity);
  #include <colorspace_fragment>
}`;
const DOT_VERT = /* glsl */`
uniform float pr;
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = 5.0 * pr; }`;
const DOT_FRAG = /* glsl */`
uniform vec3 color;
uniform float opacity;
void main() {
  if (length(gl_PointCoord - 0.5) > 0.5) discard;
  gl_FragColor = vec4(color, opacity);
  #include <colorspace_fragment>
}`;

function greatCircle(points) {
  const out = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let i = 0; i < points.length - 1; i++) {
    latLonToVec3(points[i].lat, points[i].lon, 1, a);
    latLonToVec3(points[i + 1].lat, points[i + 1].lon, 1, b);
    const ang = a.angleTo(b);
    const n = Math.max(1, Math.ceil(ang / (0.5 * DEG)));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const v = new THREE.Vector3().copy(a).multiplyScalar(Math.sin((1 - t) * ang) || (1 - t))
        .add(new THREE.Vector3().copy(b).multiplyScalar(Math.sin(t * ang) || t)).normalize().multiplyScalar(R);
      out.push(v);
    }
  }
  const last = points[points.length - 1];
  out.push(latLonToVec3(last.lat, last.lon, R, new THREE.Vector3()));
  return out;
}

export class Cyclones {
  constructor(markerRoot, listRoot, { onSelect, pixelRatio }) {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.markerRoot = markerRoot;
    this.listRoot = listRoot;
    this.onSelect = onSelect;
    this.pr = pixelRatio;
    this.storms = [];
    this.markers = [];
    this.status = 'loading';
    this._v = new THREE.Vector3();
  }

  async load() {
    try {
      const r = await fetch(BASE + 'cyclones.geojson', { cache: 'no-cache' });
      if (!r.ok) throw new Error(`The cyclone file is missing (HTTP ${r.status}).`);
      let gj;
      try { gj = await r.json(); } catch { throw new Error('The cyclone file is missing or damaged.'); }
      this.storms = gj.features.map((f) => ({ ...f.properties, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
      this.status = 'ok';
      this._build();
    } catch (e) {
      this.status = 'error';
      this.error = e.message;
    }
    this.renderList();
  }

  setError(msg) { this.status = 'error'; this.error = msg; this.renderList(); }

  _material(frag, vert, color, extra = {}) {
    return new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false,
      uniforms: { color: { value: new THREE.Color(color) }, opacity: { value: 1 }, ...extra },
    });
  }

  _build() {
    for (const s of this.storms) {
      const color = CYCLONE_COLORS[s.category] || '#ffffff';
      const op = s.active ? 1 : 0.55;
      const obs = s.track.filter((p) => !p.forecast);
      const fc = s.track.filter((p) => p.forecast);
      if (obs.length && fc.length) fc.unshift(obs[obs.length - 1]);
      for (const [pts, dashed] of [[obs, false], [fc, true]]) {
        if (pts.length < 2) continue;
        const curve = new THREE.CatmullRomCurve3(greatCircle(pts), false, 'centripetal');
        const len = curve.getLength();
        const geo = new THREE.TubeGeometry(curve, Math.min(400, Math.ceil(len / 0.004)), 0.0021, 5, false);
        const mat = this._material(TUBE_FRAG, TUBE_VERT, color, { dashed: { value: dashed ? 1 : 0 }, len: { value: len } });
        mat.uniforms.opacity.value = op * (dashed ? 0.85 : 1);
        this.group.add(new THREE.Mesh(geo, mat));
      }
      if (s.track.length) {
        const pos = new Float32Array(s.track.length * 3);
        s.track.forEach((p, i) => { latLonToVec3(p.lat, p.lon, R, this._v); pos.set([this._v.x, this._v.y, this._v.z], i * 3); });
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const m = this._material(DOT_FRAG, DOT_VERT, color, { pr: { value: this.pr } });
        m.uniforms.opacity.value = op;
        this.group.add(new THREE.Points(g, m));
      }
      // HTML marker
      const btn = el('button', {
        class: 'marker storm-marker' + (s.active ? '' : ' ended'), style: `color:${color}`,
        'aria-label': `${s.name}, ${CYCLONE_NAMES[s.category] || ''}${s.active ? '' : ', ended'}`,
        onclick: () => this.onSelect(s),
      });
      btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2.6" fill="currentColor"/><path d="M12 3.5c-4.7 0-8.5 3.8-8.5 8.5M12 20.5c4.7 0 8.5-3.8 8.5-8.5"/></svg>`;
      btn.append(el('span', { class: 'storm-label', text: `${s.name}${s.category ? ' · ' + s.category : ''}` }));
      btn.tabIndex = -1;
      btn.hidden = true;
      this.markerRoot.append(btn);
      this.markers.push({ el: btn, pos: latLonToVec3(s.lat, s.lon, 1, new THREE.Vector3()), shown: false });
    }
  }

  setVisible(v) {
    this.group.visible = v;
    if (!v) for (const m of this.markers) { m.el.hidden = true; m.shown = false; }
  }

  /** Position HTML markers; called when camera changes. */
  updateMarkers(camera, w, h) {
    if (!this.group.visible) return;
    for (const m of this.markers) {
      const visible = m.pos.dot(camera.position) > 1.02;
      if (visible) {
        this._v.copy(m.pos).project(camera);
        const x = (this._v.x * 0.5 + 0.5) * w, y = (-this._v.y * 0.5 + 0.5) * h;
        m.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      }
      if (visible !== m.shown) { m.el.hidden = !visible; m.shown = visible; }
    }
  }

  renderList() {
    const root = this.listRoot;
    root.replaceChildren();
    if (this.status === 'loading') { root.append(el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' })); return; }
    if (this.status === 'error') {
      root.append(el('p', { class: 'err', text: 'Cyclone data is unavailable right now.' }),
        el('p', { class: 'note', text: this.error || '' }));
      return;
    }
    const active = this.storms.filter((s) => s.active);
    const ended = this.storms.filter((s) => !s.active);
    if (!active.length) {
      root.append(el('p', { text: 'No active tropical cyclones worldwide right now.' }),
        el('p', { class: 'note', text: 'Source: GDACS. This list refreshes every 6 hours.' }));
    }
    const section = (title, list) => {
      if (!list.length) return;
      root.append(el('div', { class: 'storm-section', text: title }));
      const ul = el('ul', { class: 'storm-list' });
      for (const s of list) {
        const color = CYCLONE_COLORS[s.category] || '#ccc';
        const when = s.active ? `since ${new Date(s.from + 'Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
          : `ended ${new Date(s.to + 'Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
        const b = el('button', { class: s.active ? '' : 'ended', onclick: () => this.onSelect(s) },
          el('span', { class: 'storm-badge', style: `background:${color}`, text: s.category || '—', title: 'Category from peak sustained wind' }),
          el('span', {},
            el('div', { class: 'storm-name', text: s.name }),
            el('div', { class: 'storm-meta', text: [STATUS[s.status] || s.status, s.peakWindKmh ? `peak ${fmtSpeedKmh(s.peakWindKmh)}` : null, s.countries].filter(Boolean).join(' · ') }),
            el('div', { class: 'storm-meta', text: `${when}${s.source ? ' · ' + s.source : ''}${s.track.some((p) => p.forecast) ? ' · forecast track' : ''}` })),
          el('span', { class: 'storm-tag' + (s.active ? ' live' : ''), text: s.active ? 'Active' : 'Ended' }));
        ul.append(el('li', {}, b));
      }
      root.append(ul);
    };
    section('Active', active);
    section(`Recently ended · last ${14} days`, ended);
    root.append(el('p', { class: 'note', text: 'Data: GDACS (EC JRC / UN OCHA). Category is from peak sustained wind (Saffir–Simpson). Not for decision-making — follow official warnings.' }));
  }
}
