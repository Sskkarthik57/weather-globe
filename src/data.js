// Loads meta.json and the per-forecast-hour PNG textures (lazily, nearest-needed first).
// Keeps a CPU copy of each step for the value readout under the cursor.
import * as THREE from 'three';

const BASE = import.meta.env.BASE_URL + 'data/';

export class WeatherData {
  constructor() {
    this.meta = null;
    this.steps = [];      // {hour, valid: Date, file, tex, px, loading, error}
    this.listeners = new Set();
    this.queue = [];
    this.active = 0;
  }

  async loadMeta() {
    const r = await fetch(BASE + 'meta.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`the data index is missing (HTTP ${r.status})`);
    try { this.meta = await r.json(); } catch { throw new Error('the data index is missing or damaged'); }
    const g = this.meta.gfs || {};
    this.steps = (g.steps || []).map((s) => ({ ...s, valid: new Date(s.valid) }));
    this.run = g.run ? new Date(g.run) : null;
    this.enc = g.encoding;
    return this.meta;
  }

  get ok() { return this.steps.length > 0; }
  get maxHour() { return this.steps.length ? this.steps[this.steps.length - 1].hour : 0; }

  onLoad(fn) { this.listeners.add(fn); }

  /** Request steps; `priority` list of indices loaded first. Returns promise for those. */
  request(indices) {
    const ps = indices.map((i) => this._load(i, true));
    return Promise.all(ps);
  }
  prefetchAll(centerIdx) {
    const order = this.steps.map((_, i) => i).sort((a, b) => Math.abs(a - centerIdx) - Math.abs(b - centerIdx));
    for (const i of order) this._load(i, false);
  }

  _load(i, urgent) {
    const s = this.steps[i];
    if (!s) return Promise.resolve(null);
    if (s.promise) {
      if (urgent && s.queued) { // move to the front
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

  /** For forecast hour h: indices of the two bracketing steps and blend factor (loaded steps only). */
  frame(h, out) {
    const st = this.steps;
    let i = 0;
    while (i < st.length - 2 && st[i + 1].hour <= h) i++;
    let a = i, b = Math.min(i + 1, st.length - 1);
    let f = st[b].hour === st[a].hour ? 0 : (h - st[a].hour) / (st[b].hour - st[a].hour);
    f = Math.min(1, Math.max(0, f));
    // fall back to nearest loaded step if one side isn't ready yet
    if (!st[a].tex || !st[b].tex) {
      const want = f < 0.5 ? a : b;
      let best = -1, bd = 1e9;
      for (let k = 0; k < st.length; k++) if (st[k].tex && Math.abs(k - want) < bd) { bd = Math.abs(k - want); best = k; }
      if (best < 0) { out.ready = false; return out; }
      if (st[a].tex && !st[b].tex) { b = a; f = 0; } else if (!st[a].tex && st[b].tex) { a = b; f = 0; } else { a = b = best; f = 0; }
    }
    out.ready = true; out.a = a; out.b = b; out.f = f;
    return out;
  }

  /** Bilinear sample at lat/lon for frame `fr`. Returns {t: °C, u, v: m/s} or null. */
  sample(lat, lon, fr, out) {
    if (!fr.ready) return null;
    const A = this.steps[fr.a], B = this.steps[fr.b];
    const e = this.enc;
    const x = (((lon % 360) + 360) % 360), y = 90 - lat;
    const x0 = Math.floor(x), y0 = Math.min(179, Math.floor(y));
    const fx = x - x0, fy = y - y0;
    const x1 = (x0 + 1) % 360, y1 = Math.min(180, y0 + 1);
    const w = A.w;
    const get = (px, c) => {
      const v00 = px[(y0 * w + x0) * 4 + c], v10 = px[(y0 * w + x1) * 4 + c];
      const v01 = px[(y1 * w + x0) * 4 + c], v11 = px[(y1 * w + x1) * 4 + c];
      return ((v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy) / 255;
    };
    const ch = (c, enc) => {
      const v = get(A.px, c) * (1 - fr.f) + get(B.px, c) * fr.f;
      return enc.min + v * (enc.max - enc.min);
    };
    out.t = ch(0, e.r); out.u = ch(1, e.g); out.v = ch(2, e.b);
    return out;
  }
}
