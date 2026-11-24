// Loads meta.json and per-forecast-step grid files (lazily, nearest-needed first).
// Files are decoded in a worker (src/decode.worker.js) into
//   - a half-float GPU texture holding physical values (°C, m/s, AQI) for the shaders, and
//   - quantised Uint16 copies of every channel for the value readout under the cursor.
// Steps far from the current time are evicted on low-memory devices and re-fetched on demand
// (the browser's HTTP cache usually serves them again instantly).
import * as THREE from 'three';

const BASE = import.meta.env.BASE_URL + 'data/';
const ABS_BASE = new URL(BASE, location.href).href; // workers resolve URLs against their own location

export async function loadMeta() {
  const r = await fetch(BASE + 'meta.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`the data index is missing (HTTP ${r.status})`);
  try { return await r.json(); } catch { throw new Error('the data index is missing or damaged'); }
}

export const gridSupported = typeof DecompressionStream !== 'undefined' && typeof Worker !== 'undefined';

// ---- shared decode workers
const workers = [];
const pending = new Map();
let nextId = 1, rr = 0;
function decode(msg) {
  if (!workers.length) {
    const n = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./decode.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data);
      };
      workers.push(w);
    }
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    workers[rr++ % workers.length].postMessage({ id, ...msg });
  });
}

// ---- Catmull-Rom (interpolating: passes exactly through the model's grid values; the shaders use the same)
function crWeights(t, out) {
  out[0] = t * (-0.5 + t * (1 - 0.5 * t));
  out[1] = 1 + t * t * (-2.5 + 1.5 * t);
  out[2] = t * (0.5 + t * (2 - 1.5 * t));
  out[3] = t * t * (-0.5 + 0.5 * t);
  return out;
}
const WX = new Float64Array(4), WY = new Float64Array(4);
const COLS = new Int32Array(4), ROWS = new Int32Array(4);

/** One gridded layer (temperature, wind or air quality) described by a meta.json section. */
export class GridLayer {
  constructor({ maxResident = Infinity } = {}) {
    this.section = null;
    this.steps = [];   // {hour, valid: Date, file, tex, q}
    this.listeners = new Set();
    this.queue = [];
    this.active = 0;
    this.maxResident = maxResident;
    this.inUse = new Set();
    this.focus = 0;
  }

  /** section: meta.json block; base: Date that slider hour 0 refers to. */
  configure(section, base) {
    this.section = section || {};
    const s = this.section;
    this.grid = s.grid;
    this.channels = s.channels || [];
    this.gpu = s.gpu || [];
    this.run = s.run ? new Date(s.run) : null;
    const valid = s.format === 'u16-grad-deflate' && this.grid && this.channels.length && gridSupported;
    this.steps = valid ? (s.steps || []).map((st) => {
      const v = new Date(st.valid);
      return { ...st, valid: v, hour: (v.getTime() - base.getTime()) / 3600e3 };
    }) : [];
  }

  get ok() { return this.steps.length > 0; }
  get maxHour() { return this.steps.length ? this.steps[this.steps.length - 1].hour : 0; }
  get loadedCount() { return this.steps.reduce((n, s) => n + (s.tex ? 1 : 0), 0); }

  onLoad(fn) { this.listeners.add(fn); }

  /** Load the given step indices first. */
  request(indices) { return Promise.all(indices.map((i) => this._load(i, true))); }
  /** Queue steps around centerIdx (nearest first), at most `radius` steps either side, within the memory budget. */
  prefetch(centerIdx, radius = Infinity) {
    const budget = Math.min(this.maxResident, this.steps.length);
    const order = this.steps.map((_, i) => i)
      .filter((i) => Math.abs(i - centerIdx) <= radius)
      .sort((a, b) => Math.abs(a - centerIdx) - Math.abs(b - centerIdx) || b - a) // ties: prefer later (forward in time)
      .slice(0, budget);
    for (const i of order) this._load(i, false);
  }
  /** Indices of the two steps bracketing hour h. */
  bracket(h) {
    const st = this.steps;
    let i = 0;
    while (i < st.length - 2 && st[i + 1].hour <= h) i++;
    return [i, Math.min(i + 1, st.length - 1)];
  }
  /** Make sure the steps around hour h are loading (urgent), plus `ahead` steps after them. */
  ensure(h, ahead = 0) {
    if (!this.ok) return;
    const [a, b] = this.bracket(h);
    this.focus = a;
    if (!this.steps[a].tex || !this.steps[b].tex) this.request([a, b]);
    for (let k = 1; k <= ahead; k++) if (b + k < this.steps.length) this._load(b + k, false);
  }

  _load(i, urgent) {
    const s = this.steps[i];
    if (!s) return Promise.resolve(null);
    if (s.tex) return Promise.resolve(s);
    if (s.promise) {
      if (urgent && s.queued) {
        this.queue = this.queue.filter((q) => q.i !== i);
        this.queue.unshift(s.queued);
        this._pump();
      }
      return s.promise;
    }
    s.error = null;
    s.promise = new Promise((resolve) => {
      s.queued = { i, resolve };
      if (urgent) this.queue.unshift(s.queued); else this.queue.push(s.queued);
    });
    this._pump();
    return s.promise;
  }

  _pump() {
    while (this.active < 3 && this.queue.length) {
      const { i, resolve } = this.queue.shift();
      const s = this.steps[i];
      s.queued = null;
      this.active++;
      this._fetch(s).then(() => resolve(s), (e) => { s.error = e; s.promise = null; resolve(null); })
        .finally(() => { this.active--; this._evict(); this.listeners.forEach((fn) => fn(i, s)); this._pump(); });
    }
  }

  async _fetch(s) {
    const { nx, ny } = this.grid;
    const d = await decode({ url: ABS_BASE + s.file, nx, ny, channels: this.channels, gpu: this.gpu });
    s.q = d.q;
    const tex = new THREE.DataTexture(d.tex, nx, ny, this.gpu.length === 1 ? THREE.RedFormat : THREE.RGFormat, THREE.HalfFloatType);
    tex.flipY = false;
    tex.unpackAlignment = 2;
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    s.tex = tex;
  }

  /** Free the loaded steps farthest from the current time when over the memory budget. */
  _evict() {
    let n = this.loadedCount;
    if (n <= this.maxResident) return;
    const victims = this.steps.map((s, i) => i)
      .filter((i) => this.steps[i].tex && !this.inUse.has(i) && Math.abs(i - this.focus) > 1)
      .sort((a, b) => Math.abs(b - this.focus) - Math.abs(a - this.focus));
    for (const i of victims) {
      if (n <= this.maxResident) break;
      const s = this.steps[i];
      s.tex.dispose();
      s.tex = null; s.q = null; s.promise = null;
      n--;
    }
  }

  /** For hour h: the two bracketing loaded steps and blend factor. */
  frame(h, out) {
    const st = this.steps;
    if (!st.length) { out.ready = false; return out; }
    let [a, b] = this.bracket(h);
    let f = st[b].hour === st[a].hour ? 0 : (h - st[a].hour) / (st[b].hour - st[a].hour);
    f = Math.min(1, Math.max(0, f));
    if (!st[a].tex || !st[b].tex) { // fall back to the nearest loaded step
      const want = f < 0.5 ? a : b;
      let best = -1, bd = 1e9;
      for (let k = 0; k < st.length; k++) if (st[k].tex && Math.abs(k - want) < bd) { bd = Math.abs(k - want); best = k; }
      if (best < 0) { out.ready = false; return out; }
      if (st[a].tex && !st[b].tex) { b = a; f = 0; } else if (!st[a].tex && st[b].tex) { a = b; f = 0; } else { a = b = best; f = 0; }
    }
    out.ready = true; out.a = a; out.b = b; out.f = f;
    this.inUse = new Set([a, b]);
    return out;
  }

  /** Catmull-Rom sample at lat/lon for frame `fr` (same interpolation as the map); fills out[var]. */
  sample(lat, lon, fr, out) {
    if (!fr.ready) return null;
    const A = this.steps[fr.a], B = this.steps[fr.b];
    if (!A.q || !B.q) return null;
    const { nx: w, ny: h } = this.grid;
    const x = ((((lon % 360) + 360) % 360) / 360) * w;
    const y = Math.min(h - 1, Math.max(0, ((90 - lat) / 180) * (h - 1)));
    const ix = Math.floor(x), iy = Math.floor(y);
    crWeights(x - ix, WX); crWeights(y - iy, WY);
    for (let k = 0; k < 4; k++) {
      COLS[k] = (((ix - 1 + k) % w) + w) % w;
      ROWS[k] = Math.min(h - 1, Math.max(0, iy - 1 + k));
    }
    const get = (q) => {
      let v = 0;
      for (let j = 0; j < 4; j++) {
        const row = ROWS[j] * w;
        v += WY[j] * (WX[0] * q[row + COLS[0]] + WX[1] * q[row + COLS[1]] + WX[2] * q[row + COLS[2]] + WX[3] * q[row + COLS[3]]);
      }
      return v;
    };
    this.channels.forEach((c, k) => {
      const v = get(A.q[k]) * (1 - fr.f) + get(B.q[k]) * fr.f;
      out[c.var] = c.offset + v * c.scale;
    });
    return out;
  }
}
