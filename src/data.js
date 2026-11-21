// Loads meta.json and per-forecast-hour PNG layers (lazily, nearest-needed first).
// Each layer keeps a CPU copy of every loaded step for the value readout under the cursor.
import * as THREE from 'three';

const BASE = import.meta.env.BASE_URL + 'data/';

export async function loadMeta() {
  const r = await fetch(BASE + 'meta.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`the data index is missing (HTTP ${r.status})`);
  try { return await r.json(); } catch { throw new Error('the data index is missing or damaged'); }
}

/** One gridded layer (e.g. GFS weather or air quality) described by a meta.json section. */
export class GridLayer {
  constructor() {
    this.section = null;
    this.steps = [];   // {hour, valid: Date, file, tex, px, w, h}
    this.listeners = new Set();
    this.queue = [];
    this.active = 0;
  }

  /** section: meta.json block; base: Date that slider hour 0 refers to. */
  configure(section, base) {
    this.section = section || {};
    this.enc = this.section.encoding;
    this.run = this.section.run ? new Date(this.section.run) : null;
    this.steps = (this.section.steps || []).map((s) => {
      const valid = new Date(s.valid);
      return { ...s, valid, hour: (valid.getTime() - base.getTime()) / 3600e3 };
    });
  }

  get ok() { return this.steps.length > 0; }
  get maxHour() { return this.steps.length ? this.steps[this.steps.length - 1].hour : 0; }

  onLoad(fn) { this.listeners.add(fn); }

  /** Load the given step indices first. */
  request(indices) { return Promise.all(indices.map((i) => this._load(i, true))); }
  prefetchAll(centerIdx) {
    const order = this.steps.map((_, i) => i).sort((a, b) => Math.abs(a - centerIdx) - Math.abs(b - centerIdx));
    for (const i of order) this._load(i, false);
  }
  /** Indices of the two steps bracketing hour h. */
  bracket(h) {
    const st = this.steps;
    let i = 0;
    while (i < st.length - 2 && st[i + 1].hour <= h) i++;
    return [i, Math.min(i + 1, st.length - 1)];
  }
  /** Make sure the steps around hour h are loading (urgent). */
  ensure(h) {
    if (!this.ok) return;
    const [a, b] = this.bracket(h);
    if (!this.steps[a].tex || !this.steps[b].tex) this.request([a, b]);
  }

  _load(i, urgent) {
    const s = this.steps[i];
    if (!s) return Promise.resolve(null);
    if (s.promise) {
      if (urgent && s.queued) {
        this.queue = this.queue.filter((q) => q.i !== i);
        this.queue.unshift(s.queued);
        this._pump();
      }
      return s.promise;
    }
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
      this._fetch(s).then(() => resolve(s), (e) => { s.error = e; resolve(null); })
        .finally(() => { this.active--; this.listeners.forEach((fn) => fn(i, s)); this._pump(); });
    }
  }

  async _fetch(s) {
    const r = await fetch(BASE + s.file);
    if (!r.ok) throw new Error(`${s.file}: HTTP ${r.status}`);
    const blob = await r.blob();
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    s.px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    s.w = bmp.width; s.h = bmp.height;
    const tex = new THREE.Texture(bmp);
    tex.flipY = false;
    tex.premultiplyAlpha = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    s.tex = tex;
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
    return out;
  }

  /** Bilinear sample at lat/lon for frame `fr`; fills out[var] for each encoded channel. */
  sample(lat, lon, fr, out) {
    if (!fr.ready) return null;
    const A = this.steps[fr.a], B = this.steps[fr.b];
    const w = A.w, h = A.h;
    const x = ((((lon % 360) + 360) % 360) / 360) * w;
    const y = ((90 - lat) / 180) * (h - 1);
    const x0 = Math.floor(x) % w, y0 = Math.min(h - 2, Math.floor(y));
    const fx = x - Math.floor(x), fy = y - y0;
    const x1 = (x0 + 1) % w, y1 = y0 + 1;
    const get = (px, c) => {
      const v00 = px[(y0 * w + x0) * 4 + c], v10 = px[(y0 * w + x1) * 4 + c];
      const v01 = px[(y1 * w + x0) * 4 + c], v11 = px[(y1 * w + x1) * 4 + c];
      return ((v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy) / 255;
    };
    ['r', 'g', 'b'].forEach((ch, c) => {
      const e = this.enc[ch];
      if (!e) return;
      let v = get(A.px, c) * (1 - fr.f) + get(B.px, c) * fr.f;
      if (e.scale === 'sqrt') v *= v;
      out[e.var] = e.min + v * (e.max - e.min);
    });
    return out;
  }
}
