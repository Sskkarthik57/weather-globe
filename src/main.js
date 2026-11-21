import '@fontsource-variable/inter';
import './style.css';
import * as THREE from 'three';
import { probeDevice, TIERS, AdaptiveQuality } from './quality.js';
import { GlobeControls } from './controls.js';
import { Earth, Atmosphere, makeStars, makeRampTexture } from './earth.js';
import { WindParticles } from './wind.js';
import { loadMeta, GridLayer } from './data.js';
import { Cyclones } from './cyclones.js';
import { PlacePanel } from './panel.js';
import { initSearch } from './search.js';
import {
  TEMP_RAMP, WIND_RAMP, CYCLONE_COLORS, CYCLONE_NAMES, AQI_CATS, aqiCategory, rampCss, units, store, fmtTemp, fmtSpeedKmh, compass,
  fmtLatLon, latLonToVec3, vec3ToLatLon, subsolarPoint, fmtValid, fmtRelHours, fmtAgo, tempUnit, speedUnit, el, clamp,
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

function applyResolution() {
  pixelRatio = Math.min(window.devicePixelRatio || 1, tier.dprCap) * tier.renderScale;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  stars.material.uniforms.pr.value = pixelRatio;
  invalidate();
}

// ------------------------------------------------------------------ earth textures
const texLoader = new THREE.TextureLoader();
const maxAniso = renderer.capabilities.getMaxAnisotropy();
let loadedTexRes = null;
async function loadEarthTextures(res, first) {
  if (loadedTexRes === res) return;
  loadedTexRes = res;
  const load = async (name, srgb) => {
    try {
      const t = await texLoader.loadAsync(`${BASE}textures/${name}`);
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = Math.min(maxAniso, tierName === 'low' ? 2 : 8);
      return t;
    } catch {
      setProblem('tex', 'Some Earth imagery failed to load; showing a plain globe.');
      return null;
    } finally { if (first) progress('Loading Earth imagery…'); }
  };
  const [day, night, water] = await Promise.all([
    load(`day_${res}.jpg`, true), load(`night_${res}.jpg`, true),
    earth.uniforms.waterTex.value ? Promise.resolve(earth.uniforms.waterTex.value) : load('water_2k.png', false),
  ]);
  const fallback = new THREE.DataTexture(new Uint8Array([10, 20, 40, 255]), 1, 1); fallback.needsUpdate = true;
  for (const [k, t] of [['dayTex', day], ['nightTex', night], ['waterTex', water]]) {
    const old = earth.uniforms[k].value;
    earth.uniforms[k].value = t || fallback;
    if (old && old !== t && k !== 'waterTex') old.dispose();
  }
  invalidate();
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
  loadEarthTextures(tier.earthTex, false);
  applyResolution();
  updateFpsBox();
}
if (settings.quality !== 'auto') quality.setManual(settings.quality);

// ------------------------------------------------------------------ app state
const layers = { temp: true, aq: false, wind: !!wind, cyclones: false };
let meta = null;
let runBase = null;               // Date that slider hour 0 refers to (the GFS run)
const data = new GridLayer();     // GFS temperature + wind
const aq = new GridLayer();       // air quality (loaded only when the layer is switched on)
const frame = { ready: false, a: 0, b: 0, f: 0 };
const aqFrame = { ready: false, a: 0, b: 0, f: 0 };
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
      if (wind) {
        wind.shared.dataA.value = u.dataA.value;
        wind.shared.dataB.value = u.dataB.value;
        wind.shared.dataMix.value = frame.f;
      }
    }
    u.hasData.value = frame.ready ? 1 : 0;
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
  // make sure the bracketing steps are loading (air quality only while its layer is on)
  data.ensure(hour);
  if (layers.aq) aq.ensure(hour);
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
  const windActive = !!wind && layers.wind && frame.ready;
  const continuous = windActive || playing || controls.moving;
  if (camMoved) {
    cyclones.updateMarkers(camera, innerWidth, innerHeight);
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
  fpsBox.textContent = `${fps}\nquality ${tierName} (${quality.manual ? 'manual' : 'auto'})\nparticles ${wind ? wind.count : 'n/a'}\npixel ratio ${pixelRatio.toFixed(2)}\n${device.gpu.slice(0, 42)}`;
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

function readoutText(ll) {
  const s = data.ok ? data.sample(ll.lat, ll.lon, frame, sampleOut) : null;
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
    const spd = Math.hypot(s.u10, s.v10);
    const from = (Math.atan2(-s.u10, -s.v10) * 180 / Math.PI + 360) % 360;
    if (layers.wind || (!layers.temp && !layers.aq)) parts.push(`${fmtSpeedKmh(spd * 3.6)} from ${compass(from)}`);
  }
  return `${parts.join(' · ') || 'No model data'}<div class="ro-coord">${fmtLatLon(ll.lat, ll.lon)}</div>`;
}

function updateReadout(touch = false) {
  const ll = pick(hover.x, hover.y);
  if (!ll || (controls.dragging && !touch)) { if (!touch) readout.hidden = true; return; }
  readout.innerHTML = readoutText(ll);
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
  openPlace({ lat: ll.lat, lon: ll.lon });
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
  selected = place;
  latLonToVec3(place.lat, place.lon, 1, pinPos);
  controls.flyTo(place.lat, place.lon, dist ?? Math.min(controls.dist, 2.4));
  const s = data.ok ? data.sample(place.lat, place.lon, frame, {}) : null;
  if (aq.ok && !layers.aq) aq.frame(hour, aqFrame); // model AQI for the panel even if the layer is off
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
  for (const [t, pane] of [['place', 'pane-place'], ['storms', 'pane-storms']]) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === tab));
    $(pane).hidden = t !== tab;
  }
  $('tab-place').hidden = !selected;
}
function closeSheet() {
  sheet.hidden = true;
  controls.autoRotatePaused = false;
  controls.lastInteraction = performance.now();
  selected = null;
  updatePin();
  canvas.focus({ preventScroll: true });
}
$('sheet-close').addEventListener('click', closeSheet);
$('tab-place').addEventListener('click', () => openSheet('place'));
$('tab-storms').addEventListener('click', () => openSheet('storms'));
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
  if (name === 'aq' && on && aq.ok) { aq.ensure(hour); aq.prefetchAll(aq.bracket(hour)[0]); updateFrame(); }
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
}

// ------------------------------------------------------------------ time slider / play
const slider = $('time-slider');
slider.addEventListener('input', () => { setPlaying(false); setHour(parseFloat(slider.value), true); });
function setPlaying(p) {
  playing = p && data.ok;
  $('timebar').classList.toggle('playing', playing);
  $('play-btn').setAttribute('aria-label', playing ? 'Pause forecast animation' : 'Play forecast animation');
  if (playing) { data.prefetchAll(0); if (layers.aq) aq.prefetchAll(0); }
  invalidate();
}
$('play-btn').addEventListener('click', () => setPlaying(!playing));

function buildLoadSegments() {
  const seg = $('load-segments');
  seg.replaceChildren(...data.steps.slice(1).map(() => el('span')));
}
function markLoaded() {
  const spans = $('load-segments').children;
  data.steps.slice(1).forEach((s, i) => spans[i]?.classList.toggle('loaded', !!(s.tex && data.steps[i].tex)));
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
    renderLegend(); updateReadout(); panel.rerender(); cyclones.renderList();
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
initSearch($('search-input'), $('search-results'), (place) => openPlace(place, 1.9));

// ------------------------------------------------------------------ footer "updated"
function updateUpdated() {
  const parts = [];
  if (data.run) parts.push(`GFS run ${data.run.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`);
  if (meta?.generated) parts.push(`data updated ${fmtAgo(new Date(meta.generated))}`);
  $('updated').textContent = parts.join(' · ');
}
setInterval(() => { updateUpdated(); updateTimeLabel(); }, 60000);

// ------------------------------------------------------------------ boot
async function boot() {
  applyResolution();
  loaderText('Loading Earth imagery…');
  const texPromise = loadEarthTextures(tier.earthTex, true);

  let metaOk = false;
  try {
    meta = await loadMeta();
    metaOk = true;
  } catch (e) {
    setProblem('meta', `Weather data could not be loaded (${e.message}). The globe still works; layers are unavailable.`);
  }
  progress('Loading forecast…');

  if (metaOk) {
    const g = meta.gfs, q = meta.aq;
    runBase = g?.run ? new Date(g.run) : q?.run ? new Date(q.run) : new Date();
    data.configure(g, runBase);
    aq.configure(q, runBase);
    if (g?.status === 'error' || !data.ok) setProblem('gfs', g?.message || 'No forecast data available.');
    else if (g.status === 'stale') setProblem('gfs', g.message);
    if (!aq.ok) disableLayer('aq', q?.message || 'Air-quality data is unavailable right now.');
    else if (q.status === 'stale') setProblem('aq', q.message);
    aq.onLoad((i, s) => {
      if (s.error) setProblem('aqstep', `Some air-quality hours failed to load (${s.error.message}).`);
      updateFrame();
      updateReadout();
    });
    if (data.ok) {
      earth.uniforms.tRange.value.set(data.enc.r.min, data.enc.r.max);
      if (wind) wind.shared.wRange.value.set(data.enc.g.min, data.enc.g.max);
      slider.max = String(data.maxHour);
      buildLoadSegments();
      const nowH = (Date.now() - runBase.getTime()) / 3600e3;
      hour = clamp(nowH, 0, data.maxHour);
      slider.value = String(hour);
      const tick = $('now-tick');
      if (nowH >= 0 && nowH <= data.maxHour) tick.style.left = `calc(8px + (100% - 16px) * ${nowH / data.maxHour})`; else tick.hidden = true;
      data.onLoad((i, s) => {
        if (s.error) setProblem('step', `Some forecast hours failed to load (${s.error.message}).`);
        markLoaded();
        updateFrame();
        updateReadout();
      });
      let i = 0; while (i < data.steps.length - 2 && data.steps[i + 1].hour <= hour) i++;
      const first = await data.request([i, Math.min(i + 1, data.steps.length - 1)]);
      progress(); progress();
      if (first.every((x) => !x)) setProblem('gfs', 'Forecast images could not be downloaded.');
      data.prefetchAll(i);
    } else { progress(); progress(); }
    if (meta.cyclones?.status === 'ok') await cyclones.load();
    else cyclones.setError(meta.cyclones?.message || 'Cyclone data missing.');
  } else {
    progress(); progress();
    cyclones.setError('Weather data index could not be loaded.');
    for (const n of ['temp', 'wind', 'aq']) disableLayer(n, 'Data unavailable');
  }
  progress('Almost there…');
  if (data.ok === false) { layers.temp = false; layers.wind = false; }
  setLayer('temp', layers.temp);
  setLayer('wind', layers.wind);
  updateUpdated();
  setHour(hour, false);
  await texPromise;

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
}
boot().catch((e) => {
  console.error(e);
  setProblem('boot', `Something went wrong while starting: ${e.message}`);
  $('loader')?.classList.add('done');
});
