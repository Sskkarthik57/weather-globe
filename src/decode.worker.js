// Decodes "u16-grad-deflate" grid files (see scripts/update_data.py) off the main thread.
// In:  {id, url, nx, ny, channels: [{var, offset, scale}], gpu: [var names for the GPU texture]}
// Out: {id, q: [Uint16Array per channel], tex: Uint16Array (half floats, gpu channels interleaved)}
//   or {id, error}
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 112; // rebias 127 -> 15
  const m = x & 0x7fffff;
  if (e <= 0) return e < -10 ? sign : sign | (((m | 0x800000) >> (1 - e)) + 0x1000) >> 13;
  if (e >= 31) return sign | 0x7c00;
  return sign + (e << 10) + ((m + 0x1000) >> 13); // '+' lets mantissa rounding carry into the exponent
}

function unpredict(hi, lo, nx, ny) {
  const q = new Uint16Array(nx * ny);
  for (let y = 0, i = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++, i++) {
      const z = (hi[i] << 8) | lo[i];
      const r = (z >>> 1) ^ -(z & 1);
      const p = y === 0 ? (x === 0 ? 0 : q[i - 1]) : x === 0 ? q[i - nx] : q[i - 1] + q[i - nx] - q[i - nx - 1];
      q[i] = (p + r) & 0xffff;
    }
  }
  return q;
}

self.onmessage = async (e) => {
  const { id, url, nx, ny, channels, gpu } = e.data;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const stream = r.body.pipeThrough(new DecompressionStream('deflate'));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    const n = nx * ny;
    if (buf.length !== n * 2 * channels.length) throw new Error('unexpected file size');
    const q = channels.map((_, c) => unpredict(buf.subarray(2 * c * n, (2 * c + 1) * n), buf.subarray((2 * c + 1) * n, (2 * c + 2) * n), nx, ny));
    const idx = gpu.map((v) => channels.findIndex((c) => c.var === v));
    const k = idx.length;
    const tex = new Uint16Array(n * k);
    idx.forEach((ci, j) => {
      const { offset, scale } = channels[ci];
      const src = q[ci];
      let lo = 65535, hi = 0;
      for (let i = 0; i < n; i++) { const v = src[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      const lut = new Uint16Array(hi - lo + 1); // quantised values repeat a lot: convert each once
      for (let v = lo; v <= hi; v++) lut[v - lo] = toHalf(offset + v * scale);
      for (let i = 0; i < n; i++) tex[i * k + j] = lut[src[i] - lo];
    });
    self.postMessage({ id, q, tex }, [...q.map((a) => a.buffer), tex.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
