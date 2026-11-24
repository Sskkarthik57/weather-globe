import '@fontsource-variable/inter';
import './style.css';
import * as THREE from 'three';
import { probeDevice, TIERS, AdaptiveQuality } from './quality.js';
import { GlobeControls } from './controls.js';
import { Earth, Atmosphere, makeStars, makeRampTexture } from './earth.js';
import { WindParticles } from './wind.js';
import { loadMeta, GridLayer, gridSupported } from './data.js';
import { Cyclones } from './cyclones.js';
import { PlacePanel } from './panel.js';
import { Rivers, RIVER_COLORS } from './rivers.js';
import { RiverPanel } from './riverpanel.js';
import { initSearch } from './search.js';
import {
  TEMP_RAMP, WIND_RAMP, CYCLONE_COLORS, CYCLONE_NAMES, AQI_CATS, aqiCategory, rampCss, units, store, fmtTemp, fmtSpeedKmh, compass,
  fmtLatLon, latLonToVec3, vec3ToLatLon, subsolarPoint, fmtValid, fmtRelHours, fmtAgo, tempUnit, speedUnit, el, clamp, DEG,
} from './util.js';

const $ = (id) => document.getElementById(id);
const canvas = $('globe');
const BASE = import.meta.env.BASE_URL;

// ------------------------------------------------------------------ device check
const device = probeDevice();
if (!device.webgl2) {
  $('fallback').hidden = false;
  $('loader').remove();
  throw new Error('WebGL2 unavailable');
}

// ------------------------------------------------------------------ loader
const loader = { done: 0, total: 7 };
function progress(label) {
  loader.done++;
  $('loader-fill').style.width = `${Math.min(100, (loader.done / loader.total) * 100)}%`;
  if (label) $('loader-text').textContent = label;
}
function loaderText(t) { $('loader-text').textContent = t; }

// ------------------------------------------------------------------ banner (errors)
const problems = new Map();
function setProblem(key, msg) {
  if (msg) problems.set(key, msg); else problems.delete(key);
  const b = $('banner');
  b.replaceChildren(...[...problems.values()].map((m) => el('p', { text: m })));
  b.hidden = problems.size === 0;
}

// ------------------------------------------------------------------ settings state
const settings = {
  quality: store.get('quality', 'auto'),
  spin: store.get('spin', true),
  fps: false,
};
let tierName = settings.quality !== 'auto' ? settings.quality : device.tier;
let tier = TIERS[tierName];

// ------------------------------------------------------------------ renderer / scene
const renderer = new THREE.WebGLRenderer({ canvas, antialias: tier.antialias, powerPreference: 'high-performance', alpha: false, stencil: false });
renderer.autoClear = false;
renderer.setClearColor(0x06070a, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.01, 2000);
let pixelRatio = 1;

const earth = new Earth(tier);
const atmosphere = new Atmosphere(earth.uniforms);
let stars = makeStars(tier.stars, 1);
scene.add(stars, earth.mesh, atmosphere.mesh);

const windRampTex = makeRampTexture(WIND_RAMP);
const wind = device.floatRT ? new WindParticles(renderer, tier, windRampTex, new THREE.Vector2(WIND_RAMP.min, WIND_RAMP.max)) : null;
if (wind) earth.uniforms.trailTex.value = wind.trail.texture;

const rivers = new Rivers($('markers'), { sunDir: earth.uniforms.sunDir, onMarker: (p) => riverMarker(p) });
scene.add(rivers.group);

const bufSize = new THREE.Vector2();
function applyResolution() {
  pixelRatio = Math.min(window.devicePixelRatio || 1, tier.dprCap) * tier.renderScale;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  stars.material.uniforms.pr.value = pixelRatio;
  renderer.getDrawingBufferSize(bufSize);
  rivers.setResolution(bufSize.x, bufSize.y, pixelRatio);
  invalidate();
}

// ------------------------------------------------------------------ earth textures
// Images are decoded off the main thread (createImageBitmap), so loading never stalls the animation.
// The 8k day image (≈4.9 km per pixel) is used only on the high tier, on desktop GPUs that can hold it,
// and is uploaded to the GPU while nobody is interacting; dropping below high switches back to 4k.
const maxAniso = renderer.capabilities.getMaxAnisotropy();
const can8k = !device.mobile && renderer.capabilities.maxTextureSize >= 8192 && (navigator.deviceMemory ?? 8) >= 4;
const texRes = { dayTex: null, nightTex: null, waterTex: null }; // resolution currently shown / being loaded
let booted = false;
const fallbackTex = new THREE.DataTexture(new Uint8Array([10, 20, 40, 255]), 1, 1);
fallbackTex.needsUpdate = true;

async function loadImageTexture(name, srgb) {
  const r = await fetch(`${BASE}textures/${name}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const bmp = await createImageBitmap(await r.blob());
  const t = new THREE.Texture(bmp);
  t.flipY = false; // ImageBitmaps can't be flipped on upload; the Earth shader flips v instead
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(maxAniso, tierName === 'low' ? 2 : 8);
  t.needsUpdate = true;
  return t;
}

/** Resolves once the user hasn't touched the globe for a moment (auto-rotate doesn't count). */
function whenIdle() {
  const busy = () => controls.dragging || controls.fly || playing || Math.abs(controls.targetDist - controls.dist) > 1e-3 ||
    performance.now() - controls.lastInteraction < 1500;
  return new Promise((resolve) => {
    const check = () => {
      if (busy()) { setTimeout(check, 400); return; }
      if (window.requestIdleCallback) requestIdleCallback(() => (busy() ? check() : resolve()), { timeout: 1500 });
      else setTimeout(resolve, 50);
    };
    check();
  });
}

function wantedTexRes() {
  const base = tier.earthTex; // '2k' | '4k'
  return { dayTex: booted && tierName === 'high' && can8k ? '8k' : base, nightTex: base, waterTex: '2k' };
}

/** Load whichever Earth images the current tier wants and swap them in. */
async function syncEarthTextures(first = false) {
  const want = wantedTexRes();
  const files = { dayTex: (r) => `day_${r}.jpg`, nightTex: (r) => `night_${r}.jpg`, waterTex: () => 'water_2k.png' };
  await Promise.all(Object.keys(want).map(async (k) => {
    const res = want[k];
    if (texRes[k] === res) return;
    texRes[k] = res;
    let t = null;
    try {
      t = await loadImageTexture(files[k](res), k !== 'waterTex');
      if (res === '8k') { await whenIdle(); if (texRes[k] === res) renderer.initTexture(t); } // one upload, while idle
    } catch {
      setProblem('tex', 'Some Earth imagery failed to load; showing a plain globe.');
    } finally { if (first) progress('Loading Earth imagery…'); }
    if (texRes[k] !== res) { t?.dispose(); return; } // superseded by a newer tier change
    const old = earth.uniforms[k].value;
    earth.uniforms[k].value = t || fallbackTex;
    if (old && old !== fallbackTex && old !== t) old.dispose();
    invalidate();
  }));
}

// ------------------------------------------------------------------ quality
const quality = new AdaptiveQuality(tierName, {
  onTier: (name) => applyTier(name),
  onParticles: (n) => { wind?.setCount(n); },
});
function applyTier(name) {
  tierName = name; tier = TIERS[name];
  earth.setTier(tier);
  if (tier.stars !== stars.geometry.attributes.position.count) {
    scene.remove(stars); stars.geometry.dispose(); stars.material.dispose();
    stars = makeStars(tier.stars, pixelRatio); scene.add(stars);
  }
  if (wind) {
    wind.build(tier);
    wind.setCount(quality.particles);
    earth.uniforms.trailTex.value = wind.trail.texture;
  }
  syncEarthTextures();
  applyResolution();
  updateFpsBox();
}
if (settings.quality !== 'auto') quality.setManual(settings.quality);

// ------------------------------------------------------------------ app state
const layers = { temp: true, aq: false, wind: !!wind, cyclones: false, rivers: false };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let meta = null;
let runBase = null;               // Date that slider hour 0 refers to (the GFS run)
// Forecast steps kept in memory per layer: everything on desktops, a sliding window on phones.
const RESIDENT = device.mobile ? 6 : Infinity;
const data = new GridLayer({ maxResident: RESIDENT });                        // GFS temperature (0.25°); drives the time slider
const windData = new GridLayer({ maxResident: RESIDENT });                    // GFS wind (0.5°), loaded while the wind layer is on
const aq = new GridLayer({ maxResident: device.mobile ? 6 : 14 });            // air quality, loaded while its layer is on
const frame = { ready: false, a: 0, b: 0, f: 0 };
const windFrame = { ready: false, a: 0, b: 0, f: 0 };
const aqFrame = { ready: false, a: 0, b: 0, f: 0 };
const PREFETCH_RADIUS = device.mobile ? 2 : Infinity; // steps either side of the current time loaded in the background
let hour = 0;
let playing = false;
const PLAY_RATE = 3; // forecast hours per second

const controls = new GlobeControls(camera, canvas, {
  onTap: (x, y, type) => handleTap(x, y, type),
  onHover: (x, y) => { hover.x = x; hover.y = y; updateReadout(); },
  onInteract: () => invalidate(),
});
controls.autoRotate = settings.spin;
controls.lon = clamp(-new Date().getTimezoneOffset() / 4, -180, 180); // start over the viewer's longitude
controls.lat = 18;
controls.dist = controls.targetDist = 6.5;

const panel = new PlacePanel($('pane-place'));
const cyclones = new Cyclones($('markers'), $('pane-storms'), { onSelect: (s) => selectStorm(s), pixelRatio: 1 });
scene.add(cyclones.group);

let riverSel = -1;                // index of the selected river, or -1
const riverPanel = new RiverPanel($('pane-river'), {
  fly: (lat, lon, dist) => { controls.flyTo(lat, lon, dist); invalidate(); },
  selectQ: (q) => { const rv = rivers.byQ.get(q); if (rv) selectRiver(rv.i); },
  dam: (k, dam) => { rivers.flashDam(k); if (dam.pt) controls.flyTo(dam.pt[1], dam.pt[0], 1.45); invalidate(); },
});

// ------------------------------------------------------------------ frame / time
const sunLL = { lat: 0, lon: 0 };
function validDate(h) { return runBase ? new Date(runBase.getTime() + h * 3600e3) : new Date(); }
function updateFrame() {
  const u = earth.uniforms;
  if (data.ok) {
    data.frame(hour, frame);
    if (frame.ready) {
      u.dataA.value = data.steps[frame.a].tex;
      u.dataB.value = data.steps[frame.b].tex;
      u.dataMix.value = frame.f;
    }
    u.hasData.value = frame.ready ? 1 : 0;
  }
  if (windData.ok && wind && layers.wind) {
    windData.frame(hour, windFrame);
    if (windFrame.ready) {
      wind.shared.dataA.value = windData.steps[windFrame.a].tex;
      wind.shared.dataB.value = windData.steps[windFrame.b].tex;
      wind.shared.dataMix.value = windFrame.f;
    }
  }
  if (aq.ok && layers.aq) {
    aq.frame(hour, aqFrame);
    if (aqFrame.ready) {
      u.aqA.value = aq.steps[aqFrame.a].tex;
      u.aqB.value = aq.steps[aqFrame.b].tex;
      u.aqMix.value = aqFrame.f;
    }
    u.hasAq.value = aqFrame.ready ? 1 : 0;
  }
  subsolarPoint(validDate(hour), sunLL);
  latLonToVec3(sunLL.lat, sunLL.lon, 1, u.sunDir.value);
  invalidate();
}

let lastLabel = '';
function updateTimeLabel() {
  const v = validDate(hour);
  const main = fmtValid(v);
  const rel = (v.getTime() - Date.now()) / 3600e3;
  const sub = `${fmtRelHours(rel)}`;
  const key = main + sub;
  if (key !== lastLabel) {
    lastLabel = key;
    $('time-main').textContent = main;
    $('time-sub').textContent = sub;
    $('time-slider').setAttribute('aria-valuetext', `${main}, ${sub}`);
  }
}

function setHour(h, fromSlider) {
  hour = clamp(h, 0, data.maxHour);
  if (!fromSlider) $('time-slider').value = String(hour);
  // make sure the bracketing steps are loading (wind / air quality only while their layer is on);
  // while playing, also fetch a couple of steps ahead so the animation never waits
  const ahead = playing ? 2 : 0;
  data.ensure(hour, ahead);
  if (layers.wind && wind) windData.ensure(hour, ahead);
  if (layers.aq) aq.ensure(hour, ahead);
  updateFrame();
  updateTimeLabel();
  updateReadout();
}

// ------------------------------------------------------------------ render loop (on demand)
let rafId = 0, needsRender = true, lastT = performance.now(), prevContinuous = false;
const fpsBox = $('fps');
let fpsTimer = 0;

function invalidate() {
  needsRender = true;
  if (!rafId && !document.hidden) { lastT = performance.now(); rafId = requestAnimationFrame(tick); }
}

function tick(t) {
  rafId = -1; // "in tick": invalidate() calls made during this frame must not queue a second loop
  const dt = Math.min(100, Math.max(0, t - lastT));
  lastT = t;
  const camMoved = controls.update(dt);
  if (playing && data.ok) {
    let h = hour + (dt / 1000) * PLAY_RATE;
    if (h > data.maxHour) h = 0;
    setHour(h, false);
  }
  const windActive = !!wind && layers.wind && windFrame.ready;
  const riversOn = layers.rivers && rivers.status === 'ok';
  if (riversOn) rivers.step(dt / 1000, controls.dist, camera, innerHeight, !reduceMotion);
  const continuous = windActive || playing || controls.moving || (riversOn && !reduceMotion);
  if (camMoved) {
    cyclones.updateMarkers(camera, innerWidth, innerHeight);
    rivers.updateMarkers(camera, innerWidth, innerHeight);
    updatePin();
    updateWindOpacity();
  }
  if (needsRender || continuous || camMoved) {
    if (windActive) wind.step(dt / 1000, t / 1000);
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(scene, camera);
    needsRender = false;
    if (continuous && prevContinuous) quality.frame(dt);
  }
  prevContinuous = continuous;
  if (settings.fps && t - fpsTimer > 500) { fpsTimer = t; updateFpsBox(continuous); }
  rafId = (continuous || needsRender) && !document.hidden ? requestAnimationFrame(tick) : 0;
}

function updateFpsBox(continuous = prevContinuous) {
  if (!settings.fps) return;
  const fps = continuous ? `${quality.fpsShown.toFixed(0)} fps · ${quality.msShown.toFixed(1)} ms` : 'idle (render on demand)';
  fpsBox.textContent = `${fps}\nquality ${tierName} (${quality.manual ? 'manual' : 'auto'})\nparticles ${wind ? wind.count : 'n/a'}\nearth image ${texRes.dayTex || '…'}${can8k ? '' : ' (8k not supported here)'}\npixel ratio ${pixelRatio.toFixed(2)}\n${device.gpu.slice(0, 42)}`;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (rafId > 0) cancelAnimationFrame(rafId); rafId = 0; }
  else { quality.reset(); invalidate(); }
});
addEventListener('resize', applyResolution);
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  setProblem('ctx', 'The graphics context was lost (the GPU was reset). Please reload the page.');
});

// ------------------------------------------------------------------ picking / readout
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const unitSphere = new THREE.Sphere(new THREE.Vector3(), 1);
const hitPoint = new THREE.Vector3();
const hitLL = { lat: 0, lon: 0 };
const sampleOut = { t2m: 0, u10: 0, v10: 0 };
const aqOut = { aqi: 0, pm25: 0, pm10: 0 };
const hover = { x: -1, y: -1 };
const readout = $('readout');
let readoutTimer = 0;

function pick(x, y) {
  if (x < 0) return null;
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  if (!raycaster.ray.intersectSphere(unitSphere, hitPoint)) return null;
  return vec3ToLatLon(hitPoint, hitLL);
}

/** Model values (map layers) at a point for the current slider time: {t2m, u10?, v10?} or null. */
function modelSample(lat, lon, out) {
  if (!data.ok || !data.sample(lat, lon, frame, out)) return null;
  if (!(windData.ok && layers.wind && windData.sample(lat, lon, windFrame, out))) { out.u10 = undefined; out.v10 = undefined; }
  return out;
}

function readoutText(ll) {
  const s = modelSample(ll.lat, ll.lon, sampleOut);
  const parts = [];
  if (layers.aq && aq.ok) {
    const a = aq.sample(ll.lat, ll.lon, aqFrame, aqOut);
    if (a) {
      const cat = aqiCategory(a.aqi);
      parts.push(`<span class="ro-dot" style="background:${cat.color}"></span><b>AQI ${Math.round(a.aqi)}</b> ${cat.short || cat.name} · PM2.5 ${Math.round(a.pm25)} µg/m³`);
    }
  }
  if (s) {
    if (layers.temp || (!layers.wind && !layers.aq)) parts.push(`<b>${fmtTemp(s.t2m, 1)}</b>`);
    if (layers.wind && s.u10 != null) {
      const spd = Math.hypot(s.u10, s.v10);
      const from = (Math.atan2(-s.u10, -s.v10) * 180 / Math.PI + 360) % 360;
      parts.push(`${fmtSpeedKmh(spd * 3.6)} from ${compass(from)}`);
    }
  }
  return `${parts.join(' · ') || 'No model data'}<div class="ro-coord">${fmtLatLon(ll.lat, ll.lon)}</div>`;
}

/** Globe radians covered by one CSS pixel near the centre of the view (for pick tolerances). */
const radPerPx = () => ((controls.dist - 1) * 2 * Math.tan((camera.fov * DEG) / 2)) / innerHeight;

function pickRiver(ll, px) {
  if (!ll || !layers.rivers || rivers.status !== 'ok') return -1;
  return rivers.pick(ll.lat, ll.lon, px * radPerPx(), controls.dist);
}

function updateReadout(touch = false) {
  const ll = pick(hover.x, hover.y);
  const ri = controls.dragging || touch ? -1 : pickRiver(ll, 7);
  if (rivers.setHover(ri)) invalidate();
  canvas.classList.toggle('on-river', ri >= 0);
  if (!ll || (controls.dragging && !touch)) { if (!touch) readout.hidden = true; return; }
  readout.innerHTML = (ri >= 0 ? `<div class="ro-river"><span class="ro-wave"></span>${escapeHtml(rivers.rivers[ri].name)}<span class="ro-hint">click for details</span></div>` : '') + readoutText(ll);
  readout.hidden = false;
  const w = readout.offsetWidth, h = readout.offsetHeight;
  let x = hover.x + 16, y = hover.y + 16;
  if (x + w > innerWidth - 8) x = hover.x - w - 16;
  if (y + h > innerHeight - 8) y = hover.y - h - 16;
  if (touch) { x = clamp(hover.x - w / 2, 8, innerWidth - w - 8); y = Math.max(8, hover.y - h - 28); }
  readout.style.transform = `translate(${x}px, ${y}px)`;
}

function handleTap(x, y, type) {
  const ll = pick(x, y);
  if (!ll) return;
  if (type === 'touch' || type === 'pen') {
    hover.x = x; hover.y = y;
    updateReadout(true);
    clearTimeout(readoutTimer);
    readoutTimer = setTimeout(() => { readout.hidden = true; hover.x = -1; }, 2600);
  }
  // rivers layer on: a click on (or near) a river opens the river instead of the local forecast
  const ri = pickRiver(ll, type === 'mouse' ? 8 : 18);
  if (ri >= 0) { selectRiver(ri); return; }
  openPlace({ lat: ll.lat, lon: ll.lon });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ------------------------------------------------------------------ rivers
/** Select river i: highlight it with its tributaries, frame it, and show its details. */
async function selectRiver(i, { fly = true } = {}) {
  const rv = rivers.rivers[i];
  if (!rv) return;
  if (!layers.rivers) setLayer('rivers', true);
  selected = null; updatePin();
  riverSel = i;
  rivers.select(i);                  // instant highlight; markers follow once details arrive
  riverPanel.loading(rv.name);
  openSheet('river');
  if (fly) frameRiver(rv);
  renderLegend();
  invalidate();
  try {
    await rivers.loadDetails();
  } catch (e) {
    if (riverSel === i) riverPanel.error(rv.name, e.message, () => selectRiver(i, { fly: false }));
    return;
  }
  if (riverSel !== i) return;
  const d = rivers.select(i);
  riverPanel.show(rv, d, rivers.ends(rv, d), (q) => rivers.byQ.get(q) || null, rivers.details);
  rivers.updateMarkers(camera, innerWidth, innerHeight);
  invalidate();
}

/** Fly so the whole river fits in the part of the screen the panels leave free
 *  (left of the side panel on desktop, above the bottom sheet on phones). */
function frameRiver(rv) {
  const W = innerWidth, H = innerHeight;
  const box = W < 720 ? { l: 8, r: W - 8, t: 120, b: H * 0.36 } : { l: 200, r: W - 400, t: 70, b: H - 190 };
  const aw = Math.max(140, box.r - box.l), ah = Math.max(140, box.b - box.t);
  const k = 2 * Math.tan((camera.fov * DEG) / 2);
  const dist = clamp(1 + (2.3 * rv.radius * H) / (k * Math.min(aw, ah)), 1.25, 6);
  const pxPerRad = H / (k * (dist - 1));
  const dx = (box.l + box.r) / 2 - W / 2, dy = (box.t + box.b) / 2 - H / 2;
  const c = vec3ToLatLon(rv.centre, {});
  const lat = clamp(c.lat + dy / pxPerRad / DEG, -80, 80);
  const lon = c.lon - dx / pxPerRad / DEG / Math.max(0.2, Math.cos(c.lat * DEG));
  controls.flyTo(lat, lon, dist);
}

function clearRiver() {
  if (riverSel < 0) return;
  riverSel = -1;
  rivers.clearSelection();
  $('tab-river').hidden = true;
  renderLegend();
  invalidate();
}

function riverMarker(p) {
  if (p.kind === 'dam') {
    rivers.flashDam(p.index);
    riverPanel.focusDam(p.index);
    controls.flyTo(p.item.pt[1], p.item.pt[0], Math.min(controls.dist, 1.45));
  } else if (p.kind === 'trib') {
    controls.flyTo(p.item.pt[1], p.item.pt[0], Math.min(controls.dist, 1.6));
  }
  invalidate();
}

// ------------------------------------------------------------------ place / pin
let selected = null;
const pinEl = el('div', { class: 'marker pin', hidden: true });
$('markers').append(pinEl);
const pinPos = new THREE.Vector3(), tmpV = new THREE.Vector3();
function updatePin() {
  if (!selected) { pinEl.hidden = true; return; }
  const vis = pinPos.dot(camera.position) > 1.0;
  pinEl.hidden = !vis;
  if (!vis) return;
  tmpV.copy(pinPos).project(camera);
  pinEl.style.transform = `translate(${((tmpV.x * 0.5 + 0.5) * innerWidth).toFixed(1)}px, ${((-tmpV.y * 0.5 + 0.5) * innerHeight).toFixed(1)}px)`;
}

function openPlace(place, dist) {
  clearRiver();
  selected = place;
  latLonToVec3(place.lat, place.lon, 1, pinPos);
  controls.flyTo(place.lat, place.lon, dist ?? Math.min(controls.dist, 2.4));
  const s = modelSample(place.lat, place.lon, {});
  if (aq.ok && !layers.aq) aq.frame(hour, aqFrame); // model AQI for the panel if those steps happen to be loaded
  const a = aq.ok ? aq.sample(place.lat, place.lon, aqFrame, {}) : null;
  panel.show({ ...place }, s, fmtValid(validDate(hour)), a);
  openSheet('place');
  updatePin();
  invalidate();
}

function selectStorm(s) {
  if (!layers.cyclones) setLayer('cyclones', true);
  controls.flyTo(s.lat, s.lon, 2.1);
  openSheet('storms');
  invalidate();
}

// ------------------------------------------------------------------ sheet / tabs
const sheet = $('sheet');
function openSheet(tab) {
  sheet.hidden = false;
  controls.autoRotatePaused = true;
  for (const [t, pane] of [['place', 'pane-place'], ['storms', 'pane-storms'], ['river', 'pane-river']]) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === tab));
    $(pane).hidden = t !== tab;
  }
  $('tab-place').hidden = !selected;
  $('tab-river').hidden = riverSel < 0;
}
function closeSheet() {
  sheet.hidden = true;
  controls.autoRotatePaused = false;
  controls.lastInteraction = performance.now();
  selected = null;
  updatePin();
  clearRiver();
  canvas.focus({ preventScroll: true });
}
$('sheet-close').addEventListener('click', closeSheet);
$('tab-place').addEventListener('click', () => openSheet('place'));
$('tab-storms').addEventListener('click', () => openSheet('storms'));
$('tab-river').addEventListener('click', () => openSheet('river'));
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tabs = [...document.querySelectorAll('.tabs [role=tab]')].filter((t) => !t.hidden);
  const i = tabs.indexOf(document.activeElement);
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  next?.focus(); next?.click();
});

// ------------------------------------------------------------------ layers
// streaks are drawn in a fixed-resolution map texture: soften them as we zoom in so they don't look chunky
function updateWindOpacity() {
  if (!wind) return;
  const base = (layers.temp || layers.aq) ? 0.55 : 0.95;
  wind.lineMat.uniforms.opacity.value = base * clamp((controls.dist - 1) / 1.3, 0.45, 1);
}
function setLayer(name, on) {
  // temperature and air quality both colour the whole globe, so only one of them is shown at a time
  const rival = { temp: 'aq', aq: 'temp' }[name];
  if (on && rival && layers[rival]) {
    layers[rival] = false;
    document.querySelector(`[data-layer="${rival}"]`).setAttribute('aria-pressed', 'false');
  }
  layers[name] = on;
  document.querySelector(`[data-layer="${name}"]`).setAttribute('aria-pressed', String(on));
  const u = earth.uniforms;
  u.tempOn.value = layers.temp ? 1 : 0;
  u.aqOn.value = layers.aq ? 1 : 0;
  u.windOn.value = layers.wind ? 1 : 0;
  if (name === 'aq' && on && aq.ok) { aq.ensure(hour); aq.prefetch(aq.bracket(hour)[0], PREFETCH_RADIUS); updateFrame(); }
  if (name === 'wind' && on && windData.ok && wind) { windData.ensure(hour); windData.prefetch(windData.bracket(hour)[0], PREFETCH_RADIUS); updateFrame(); }
  if (wind) {
    wind.lineMat.uniforms.colorMode.value = (layers.temp || layers.aq) ? 0 : 1;
    updateWindOpacity();
    if (name === 'wind' && on) wind.clearTrails();
  }
  if (name === 'cyclones') {
    cyclones.setVisible(on);
    $('tab-storms').hidden = !on;
    if (on) { openSheet('storms'); cyclones.updateMarkers(camera, innerWidth, innerHeight); }
    else if (!sheet.hidden && !$('pane-storms').hidden) { if (selected) openSheet('place'); else closeSheet(); }
  }
  if (name === 'rivers') {
    if (on) {
      const btn = document.querySelector('[data-layer="rivers"]');
      if (rivers.status !== 'ok') btn.classList.add('busy');
      rivers.load().then(() => {
        btn.classList.remove('busy');
        setProblem('rivers', null);
        rivers.setVisible(layers.rivers);
        rivers.updateMarkers(camera, innerWidth, innerHeight);
        renderLegend(); invalidate();
      }, (e) => {
        btn.classList.remove('busy');
        setProblem('rivers', `River data could not be loaded (${e.message}).`);
        layers.rivers = false; btn.setAttribute('aria-pressed', 'false');
      });
      rivers.loadDetails().catch(() => {}); // warm up, so the first click shows details instantly
    } else {
      rivers.setHover(-1);
      canvas.classList.remove('on-river');
      const showingRiver = !sheet.hidden && !$('pane-river').hidden;
      clearRiver();
      if (showingRiver) { if (selected) openSheet('place'); else if (layers.cyclones) openSheet('storms'); else closeSheet(); }
    }
    rivers.setVisible(on);
  }
  renderLegend();
  updateReadout();
  invalidate();
}
function disableLayer(name, reason) {
  const b = document.querySelector(`[data-layer="${name}"]`);
  b.disabled = true; b.setAttribute('aria-pressed', 'false'); b.title = reason;
  layers[name] = false;
}
for (const b of document.querySelectorAll('.layer-btn')) {
  b.addEventListener('click', () => setLayer(b.dataset.layer, b.getAttribute('aria-pressed') !== 'true'));
}
if (!wind) {
  const b = document.querySelector('[data-layer="wind"]');
  b.disabled = true; b.setAttribute('aria-pressed', 'false');
  b.title = 'Wind particles need floating-point render targets, which this device does not support.';
  setProblem('wind', 'Wind particles aren’t supported on this device’s graphics chip; other layers work normally.');
}

// ------------------------------------------------------------------ legend
function renderLegend() {
  const L = $('legend');
  L.replaceChildren();
  const imperial = units.system === 'imperial';
  if (layers.temp && data.ok) {
    const ticks = [-40, -20, 0, 20, 40];
    L.append(el('div', { class: 'lg' },
      el('span', { class: 'lg-title', text: `Temperature ${tempUnit()}` }),
      el('div', { class: 'lg-bar', style: `background:${rampCss(TEMP_RAMP)}` }),
      el('div', { class: 'lg-ticks' }, ...ticks.map((t) => el('span', { text: String(Math.round(imperial ? t * 9 / 5 + 32 : t)) })))));
  }
  if (layers.aq && aq.ok) {
    L.append(el('div', { class: 'lg lg-aq' },
      el('span', { class: 'lg-title', text: 'Air quality (US AQI)' }),
      el('div', { class: 'lg-bar lg-steps' }, ...AQI_CATS.map((c) => el('span', { style: `background:${c.color}`, title: `${c.name}: ${c.advice}` }))),
      el('div', { class: 'lg-ticks' }, ...['0', '50', '100', '150', '200', '300', '500'].map((t) => el('span', { text: t }))),
      el('div', { class: 'lg-ticks lg-names' }, ...AQI_CATS.map((c) => el('span', { text: c.short || c.name })))));
  }
  if (layers.wind && wind && data.ok) {
    if (layers.temp || layers.aq) {
      L.append(el('div', { class: 'lg' }, el('span', { class: 'lg-title', text: 'Wind' }),
        el('span', { class: 'lg-note', text: 'white streaks follow the flow; longer = faster' })));
    } else {
      const ms = [0, 10, 20, 30];
      L.append(el('div', { class: 'lg' },
        el('span', { class: 'lg-title', text: `Wind ${speedUnit()}` }),
        el('div', { class: 'lg-bar', style: `background:${rampCss(WIND_RAMP)}` }),
        el('div', { class: 'lg-ticks' }, ...ms.map((v) => el('span', { text: String(Math.round(imperial ? v * 2.23694 : v * 3.6)) })))));
    }
  }
  if (layers.cyclones) {
    L.append(el('div', { class: 'lg' }, el('span', { class: 'lg-title', text: 'Cyclones' }),
      el('div', { class: 'lg-cats' }, ...Object.entries(CYCLONE_COLORS).map(([k, c]) =>
        el('span', { class: 'lg-cat', style: `background:${c}`, title: CYCLONE_NAMES[k], text: k.replace('Cat ', 'C') })))));
  }
  if (layers.rivers && rivers.status === 'ok') {
    const key = (color, text, cls = '') => el('span', { class: 'lg-key' }, el('i', { class: cls, style: `background:${color}` }), text);
    L.append(el('div', { class: 'lg lg-rivers' }, el('span', { class: 'lg-title', text: 'Rivers' }),
      riverSel >= 0
        ? el('div', { class: 'lg-keys' }, key(RIVER_COLORS.selected, 'selected'), key(RIVER_COLORS.trib, 'tributaries'),
          key(RIVER_COLORS.mouth, 'drains into'), key(RIVER_COLORS.source, 'source', 'dot'), key(RIVER_COLORS.dam, 'dams', 'sq'))
        : el('span', { class: 'lg-note', text: 'pulses flow downstream · click a river for its source, tributaries and dams' })));
  }
}

// ------------------------------------------------------------------ time slider / play
const slider = $('time-slider');
slider.addEventListener('input', () => { setPlaying(false); setHour(parseFloat(slider.value), true); });
function setPlaying(p) {
  playing = p && data.ok;
  $('timebar').classList.toggle('playing', playing);
  $('play-btn').setAttribute('aria-label', playing ? 'Pause forecast animation' : 'Play forecast animation');
  if (playing) setHour(hour, false); // starts the look-ahead loading
  invalidate();
}
$('play-btn').addEventListener('click', () => setPlaying(!playing));

function buildLoadSegments() {
  const seg = $('load-segments');
  seg.replaceChildren(...data.steps.slice(1).map(() => el('span')));
}
function markLoaded() {
  const spans = $('load-segments').children;
  const has = (L, i) => !L.ok || !!L.steps[i]?.tex;
  const ready = (i) => has(data, i) && (!layers.wind || !wind || has(windData, i)) && (!layers.aq || has(aq, i));
  data.steps.slice(1).forEach((s, i) => spans[i]?.classList.toggle('loaded', ready(i) && ready(i + 1)));
}

// ------------------------------------------------------------------ settings / keyboard
const settingsBox = $('settings');
function toggleSettings(open = settingsBox.hidden) {
  settingsBox.hidden = !open;
  $('settings-btn').setAttribute('aria-expanded', String(open));
  if (open) settingsBox.querySelector('[aria-checked="true"]')?.focus();
}
$('settings-btn').addEventListener('click', () => toggleSettings());
document.addEventListener('pointerdown', (e) => {
  if (!settingsBox.hidden && !settingsBox.contains(e.target) && !$('settings-btn').contains(e.target)) toggleSettings(false);
  if (!$('credits').hidden && !$('credits').contains(e.target) && e.target !== $('credits-btn')) toggleCredits(false);
});
function radio(groupAttr, value) {
  for (const b of settingsBox.querySelectorAll(`[${groupAttr}]`)) b.setAttribute('aria-checked', String(b.getAttribute(groupAttr) === value));
}
for (const b of settingsBox.querySelectorAll('[data-quality]')) {
  b.addEventListener('click', () => {
    settings.quality = b.dataset.quality; store.set('quality', settings.quality);
    radio('data-quality', settings.quality);
    quality.setManual(settings.quality === 'auto' ? null : settings.quality);
    updateFpsBox();
  });
}
for (const b of settingsBox.querySelectorAll('[data-units]')) {
  b.addEventListener('click', () => {
    units.system = b.dataset.units; store.set('units', units.system);
    radio('data-units', units.system);
    renderLegend(); updateReadout(); panel.rerender(); cyclones.renderList(); riverPanel.rerender();
  });
}
radio('data-quality', settings.quality);
radio('data-units', units.system);
function setFps(on) { settings.fps = on; fpsBox.hidden = !on; $('fps-toggle').checked = on; updateFpsBox(); }
$('fps-toggle').addEventListener('change', (e) => setFps(e.target.checked));
$('spin-toggle').checked = settings.spin;
$('spin-toggle').addEventListener('change', (e) => { settings.spin = e.target.checked; store.set('spin', settings.spin); controls.autoRotate = settings.spin; invalidate(); });

function toggleCredits(open = $('credits').hidden) {
  $('credits').hidden = !open;
  $('credits-btn').setAttribute('aria-expanded', String(open));
}
$('credits-btn').addEventListener('click', () => toggleCredits());

document.addEventListener('keydown', (e) => {
  const typing = e.target.matches('input[type=search], input[type=text]');
  if (e.key === 'Escape') {
    if (!settingsBox.hidden) toggleSettings(false);
    else if (!$('credits').hidden) toggleCredits(false);
    else if (!sheet.hidden) closeSheet();
  } else if (e.key === 'F' && e.shiftKey && !typing) {
    setFps(!settings.fps);
  } else if (e.key === ' ' && (e.target === document.body || e.target === canvas)) {
    e.preventDefault(); setPlaying(!playing);
  }
});

// ------------------------------------------------------------------ search
initSearch($('search-input'), $('search-results'), (place) => (place.river ? selectRiver(place.river.i) : openPlace(place, place.dist ?? 1.8)), {
  local: (q) => rivers.search(q).map((rv) => ({
    river: rv, name: rv.name, kind: 'River', lat: 0, lon: 0,
    sub: rivers.details?.[rv.q]?.countries?.slice(0, 3).join(', ') || 'Click to see source, tributaries and dams',
  })),
  // when zoomed in, rank matches near the area on screen higher (e.g. "Springfield")
  // (camera distance 3 -> map zoom 6 ... 1.2 -> 11; Photon looks for nearby matches within roughly that map view)
  getBias: () => (controls.dist < 3.2 ? { lat: controls.lat, lon: controls.lon, zoom: Math.round(clamp(15 - 3 * controls.dist, 5, 12)) } : null),
});

// river names are searched locally: start loading them as soon as someone goes to type, and refresh
// the open result list when they arrive (so "Nile" typed early still shows the river)
$('search-input').addEventListener('focus', () => {
  if (rivers.status === 'ok') return;
  rivers.load().then(() => {
    const inp = $('search-input');
    if (document.activeElement === inp && inp.value.trim().length >= 2) inp.dispatchEvent(new Event('input'));
  }).catch(() => {});
});

const locateBtn = $('locate-btn');
locateBtn.addEventListener('click', () => {
  if (!navigator.geolocation) { setProblem('geo', 'Your location isn’t available in this browser. You can still search or click the globe.'); return; }
  locateBtn.disabled = true; locateBtn.classList.add('busy');
  const done = (msg) => {
    locateBtn.disabled = false; locateBtn.classList.remove('busy');
    setProblem('geo', msg);
    if (msg) setTimeout(() => setProblem('geo', null), 7000);
  };
  navigator.geolocation.getCurrentPosition(
    (p) => { done(null); openPlace({ lat: p.coords.latitude, lon: p.coords.longitude }, 1.6); },
    (e) => done(e.code === 1 ? 'Location permission was denied. You can still search or click the globe.' : 'Your location couldn’t be found right now. Please try again.'),
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 10 * 60e3 },
  );
});

// ------------------------------------------------------------------ footer "updated"
function updateUpdated() {
  const parts = [];
  if (data.run) parts.push(`GFS 0.25° run ${data.run.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`);
  if (meta?.generated) parts.push(`data updated ${fmtAgo(new Date(meta.generated))}`);
  $('updated').textContent = parts.join(' · ');
}
setInterval(() => { updateUpdated(); updateTimeLabel(); }, 60000);

// ------------------------------------------------------------------ boot
async function boot() {
  applyResolution();
  loaderText('Loading Earth imagery…');
  const texPromise = syncEarthTextures(true);

  let metaOk = false;
  try {
    meta = await loadMeta();
    metaOk = true;
  } catch (e) {
    setProblem('meta', `Weather data could not be loaded (${e.message}). The globe still works; layers are unavailable.`);
  }
  progress('Loading forecast…');

  if (metaOk) {
    const g = meta.gfs, t = meta.temp, w = meta.wind, q = meta.aq;
    runBase = g?.run ? new Date(g.run) : q?.run ? new Date(q.run) : new Date();
    data.configure(t, runBase);
    windData.configure(w, runBase);
    aq.configure(q, runBase);
    const oldBrowser = 'This browser is too old to unpack the forecast data (needs DecompressionStream: Chrome 80, Safari 16.4, Firefox 113 or newer).';
    if (!gridSupported) setProblem('gfs', oldBrowser);
    else if (g?.status === 'error' || !data.ok) setProblem('gfs', g?.message || t?.message || 'No forecast data available.');
    else if (g.status === 'stale') setProblem('gfs', g.message);
    if (!aq.ok) disableLayer('aq', gridSupported ? (q?.message || 'Air-quality data is unavailable right now.') : oldBrowser);
    else if (q.status === 'stale') setProblem('aq', q.message);
    if (!windData.ok && wind) disableLayer('wind', w?.message || 'Wind data is unavailable right now.');
    const onStep = (key, label) => (i, s) => {
      if (s.error) setProblem(key, `Some ${label} hours failed to load (${s.error.message}).`);
      markLoaded();
      updateFrame();
      updateReadout();
    };
    aq.onLoad(onStep('aqstep', 'air-quality'));
    windData.onLoad(onStep('windstep', 'wind'));
    if (data.ok) {
      slider.max = String(data.maxHour);
      buildLoadSegments();
      const nowH = (Date.now() - runBase.getTime()) / 3600e3;
      hour = clamp(nowH, 0, data.maxHour);
      slider.value = String(hour);
      const tick = $('now-tick');
      if (nowH >= 0 && nowH <= data.maxHour) tick.style.left = `calc(8px + (100% - 16px) * ${nowH / data.maxHour})`; else tick.hidden = true;
      data.onLoad(onStep('step', 'forecast'));
      const [i, j] = data.bracket(hour);
      const wantWind = layers.wind && wind && windData.ok;
      const [first] = await Promise.all([data.request([i, j]), wantWind ? windData.request(windData.bracket(hour)) : null]);
      progress(); progress();
      if (first.every((x) => !x)) setProblem('gfs', `Forecast data could not be downloaded (${data.steps[i].error?.message || 'network error'}).`);
      data.prefetch(i, PREFETCH_RADIUS);
      if (wantWind) windData.prefetch(windData.bracket(hour)[0], PREFETCH_RADIUS);
    } else { progress(); progress(); }
    if (meta.cyclones?.status === 'ok') await cyclones.load();
    else cyclones.setError(meta.cyclones?.message || 'Cyclone data missing.');
  } else {
    progress(); progress();
    cyclones.setError('Weather data index could not be loaded.');
    for (const n of ['temp', 'wind', 'aq']) disableLayer(n, 'Data unavailable');
  }
  progress('Almost there…');
  if (data.ok === false) layers.temp = false;
  if (windData.ok === false) layers.wind = false;
  setLayer('temp', layers.temp);
  setLayer('wind', layers.wind);
  updateUpdated();
  setHour(hour, false);
  await texPromise;
  booted = true;
  syncEarthTextures(); // high tier on a capable GPU: fetch the 8k day image in the background

  // render one frame before revealing, then cinematic intro
  renderer.compile(scene, camera);
  invalidate();
  requestAnimationFrame(() => {
    $('loader').classList.add('done');
    setTimeout(() => $('loader').remove(), 900);
    controls.flyTo(controls.lat, controls.lon, innerWidth < 720 ? 3.9 : 3.1);
    invalidate();
  });
  if (location.hash === '#fps') setFps(true);
  // river lines load quietly after start-up, so river names work in search right away
  whenIdle().then(() => rivers.load()).catch(() => {});
}
boot().catch((e) => {
  console.error(e);
  setProblem('boot', `Something went wrong while starting: ${e.message}`);
  $('loader')?.classList.add('done');
});
