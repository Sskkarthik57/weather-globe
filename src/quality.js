// Quality tiers, start-tier detection from device hints, and adaptive adjustment with hysteresis.

export const TIERS = {
  low: {
    name: 'low', particleTex: [128, 128], particles: 9000, particlesMin: 3000,
    dprCap: 1.5, renderScale: 0.85, earthTex: '2k', atmosphere: 0, trailRes: [2048, 1024], segments: 96, stars: 1400, antialias: false,
  },
  medium: {
    name: 'medium', particleTex: [256, 128], particles: 22000, particlesMin: 8000,
    dprCap: 1.5, renderScale: 1, earthTex: '4k', atmosphere: 1, trailRes: [2048, 1024], segments: 128, stars: 2600, antialias: true,
  },
  high: {
    name: 'high', particleTex: [256, 256], particles: 45000, particlesMin: 16000,
    dprCap: 2, renderScale: 1, earthTex: '4k', atmosphere: 2, trailRes: [2048, 1024], segments: 160, stars: 4000, antialias: true,
  },
};
const ORDER = ['low', 'medium', 'high'];

/** Inspect the device before creating the renderer. Returns {webgl2, floatRT, tier, gpu, reasons}. */
export function probeDevice() {
  const c = document.createElement('canvas');
  let gl = null;
  try { gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: false }); } catch { gl = null; }
  if (!gl) return { webgl2: false };
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  const floatRT = !!gl.getExtension('EXT_color_buffer_float');
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  gl.getExtension('WEBGL_lose_context')?.loseContext();

  const reasons = [];
  const coarse = matchMedia('(pointer: coarse)').matches;
  const smallScreen = Math.min(screen.width, screen.height) < 820;
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const mobile = (coarse && smallScreen) || mobileUA;
  const cores = navigator.hardwareConcurrency || 4;
  const software = /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  const discrete = /NVIDIA|GeForce|RTX|GTX|Quadro|Radeon RX|Radeon Pro|Apple M\d (Pro|Max|Ultra)/i.test(gpu);

  let tier = 'medium';
  if (software) { tier = 'low'; reasons.push('software renderer'); }
  else if (mobile) { tier = 'low'; reasons.push('mobile device'); }
  else if (maxTex < 4096) { tier = 'low'; reasons.push('small max texture'); }
  else if (discrete && cores >= 6) { tier = 'high'; reasons.push('discrete GPU'); }
  else reasons.push('desktop / integrated GPU');
  if (cores <= 2 && tier !== 'low') { tier = 'low'; reasons.push('few CPU cores'); }
  return { webgl2: true, floatRT, maxTex, gpu, tier, mobile, software, reasons };
}

/**
 * Watches frame times of continuously-rendered frames.
 *  - first tunes particle count inside the tier,
 *  - then moves tiers, with hysteresis: slow to upgrade, quick to downgrade,
 *    and a growing lock-out on re-upgrading a tier that was just too slow.
 */
export class AdaptiveQuality {
  constructor(tierName, { onTier, onParticles }) {
    this.tier = tierName;
    this.manual = null;
    this.onTier = onTier;
    this.onParticles = onParticles;
    this.particles = TIERS[tierName].particles;
    this.block = { low: 0, medium: 0, high: 0 };
    this.strikes = { low: 0, medium: 0, high: 0 };
    this.reset();
  }
  reset() {
    this.sum = 0; this.n = 0; this.slow = 0; this.windowStart = performance.now();
    this.warmupUntil = performance.now() + 2500;
    this.goodWindows = 0; this.badWindows = 0;
    this.fpsShown = 0; this.msShown = 0;
  }
  setManual(name) { // null = auto
    this.manual = name;
    if (name && name !== this.tier) this._setTier(name, false);
    this.reset();
  }
  /** dt in ms between two consecutive rendered frames. */
  frame(dt) {
    const now = performance.now();
    if (dt > 250) return; // stall (tab switch, breakpoint) – ignore
    this.sum += dt; this.n++;
    if (dt > 22) this.slow++;
    if (now - this.windowStart < 1000) return;
    const avg = this.sum / this.n;
    const slowShare = this.slow / this.n;
    this.fpsShown = 1000 / avg; this.msShown = avg;
    this.sum = 0; this.n = 0; this.slow = 0; this.windowStart = now;
    if (now < this.warmupUntil) return;

    const t = TIERS[this.tier];
    const max = t.particleTex[0] * t.particleTex[1];
    if (avg > 19.5 || slowShare > 0.25) {
      this.goodWindows = 0; this.badWindows++;
      if (this.particles > t.particlesMin) {
        this._setParticles(Math.max(t.particlesMin, Math.round(this.particles * 0.75)));
      } else if (this.badWindows >= 2 && !this.manual) {
        const i = ORDER.indexOf(this.tier);
        if (i > 0) {
          this.strikes[this.tier]++;
          this.block[this.tier] = now + 60000 * Math.pow(2, this.strikes[this.tier]);
          this._setTier(ORDER[i - 1], true);
        }
      }
    } else if (avg < 17.6 && slowShare < 0.05) {
      this.badWindows = 0; this.goodWindows++;
      if (this.goodWindows >= 3 && this.particles < max) {
        this._setParticles(Math.min(max, Math.round(this.particles * 1.12)));
        this.goodWindows = 0;
      } else if (this.goodWindows >= 10 && this.particles >= max && !this.manual) {
        const i = ORDER.indexOf(this.tier);
        const next = ORDER[i + 1];
        if (next && now > this.block[next]) this._setTier(next, false);
        this.goodWindows = 0;
      }
    } else {
      this.goodWindows = 0; this.badWindows = 0;
    }
  }
  _setParticles(n) { this.particles = n; this.onParticles(n); }
  _setTier(name, down) {
    this.tier = name;
    const t = TIERS[name];
    this.particles = down ? t.particles : Math.max(t.particlesMin, Math.min(t.particles, this.particles));
    this.warmupUntil = performance.now() + 3000;
    this.goodWindows = 0; this.badWindows = 0;
    this.onTier(name);
  }
}
