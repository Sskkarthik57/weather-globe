// Local weather panel: Open-Meteo current conditions + 48 h chart, Nominatim reverse geocoding.
import { el, fmtTemp, fmtSpeedKmh, fmtLatLon, compass, WMO, tempValue, tempUnit, aqiCategory } from './util.js';

const OM = 'https://api.open-meteo.com/v1/forecast';
const OM_AQ = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
let lastNominatim = 0;
let ctrl = null;

async function reverseName(lat, lon, signal) {
  // Nominatim usage policy: max 1 request/second, only on explicit user action, with attribution.
  const wait = Math.max(0, lastNominatim + 1100 - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  lastNominatim = Date.now();
  const r = await fetch(`${NOMINATIM}?format=jsonv2&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&zoom=10&accept-language=en`, { signal });
  if (!r.ok) return null;
  const j = await r.json();
  if (j.error) return { name: null };
  const a = j.address || {};
  const name = j.name || a.city || a.town || a.village || a.county || a.state;
  const sub = [a.state, a.country].filter((x) => x && x !== name).join(', ');
  return { name, sub };
}

export class PlacePanel {
  constructor(root) { this.root = root; this.last = null; }

  /** place: {lat, lon, name?, sub?}; modelSample: {t2m,u10,v10} from GFS at the slider time (or null);
   *  modelAq: {aqi,pm25,pm10} from the air-quality layer at the slider time (or null) */
  async show(place, modelSample, modelTimeLabel, modelAq) {
    ctrl?.abort();
    ctrl = new AbortController();
    const { signal } = ctrl;
    this.last = { place, modelSample, modelTimeLabel, modelAq };
    // air quality is a separate free API call; it fails independently of the weather forecast
    const aqPromise = fetch(`${OM_AQ}?latitude=${place.lat.toFixed(3)}&longitude=${place.lon.toFixed(3)}` +
      '&current=us_aqi,european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide' +
      '&hourly=us_aqi&forecast_hours=24&timezone=auto', { signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
    aqPromise.catch(() => {}); // handled in render
    const r = this.root;
    r.replaceChildren();
    const title = el('h2', { class: 'place-title', text: place.name || 'Locating…' });
    const sub = el('div', { class: 'place-sub', text: [place.sub, fmtLatLon(place.lat, place.lon)].filter(Boolean).join(' · ') });
    const body = el('div', {}, el('div', { class: 'skeleton', style: 'height:46px;width:55%' }), el('div', { class: 'skeleton' }), el('div', { class: 'skeleton', style: 'height:120px' }));
    r.append(title, sub, body);

    if (!place.name) {
      reverseName(place.lat, place.lon, signal).then((n) => {
        if (signal.aborted) return;
        if (n?.name) { title.textContent = n.name; place.name = n.name; place.sub = n.sub; sub.textContent = [n.sub, fmtLatLon(place.lat, place.lon)].filter(Boolean).join(' · '); }
        else { title.textContent = n ? 'Open water / remote area' : 'Selected point'; }
      }).catch(() => { if (!signal.aborted) title.textContent = 'Selected point'; });
    }

    try {
      const url = `${OM}?latitude=${place.lat.toFixed(3)}&longitude=${place.lon.toFixed(3)}` +
        '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,pressure_msl,cloud_cover,is_day' +
        '&hourly=temperature_2m,precipitation_probability&forecast_hours=48&timezone=auto';
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`Open-Meteo returned HTTP ${res.status}${res.status === 429 ? ' (rate limit, try again shortly)' : ''}`);
      const d = await res.json();
      if (signal.aborted) return;
      this.data = d;
      this._render(body, d, modelSample, modelTimeLabel);
      const aqBox = el('div', { class: 'aq-box' }, el('div', { class: 'skeleton', style: 'width:60%' }));
      body.insertBefore(aqBox, body.children[2] || null);
      aqPromise.then((a) => { if (!signal.aborted) this._renderAq(aqBox, a, modelAq); },
        (e) => {
          if (signal.aborted || e.name === 'AbortError') return;
          aqBox.replaceChildren(el('p', { class: 'err', text: 'Air-quality data couldn’t be loaded for this place.' }), el('p', { class: 'note', text: e.message }));
        });
    } catch (e) {
      if (e.name === 'AbortError') return;
      body.replaceChildren(el('p', { class: 'err', text: 'Couldn’t load the local forecast.' }), el('p', { class: 'note', text: e.message }),
        el('button', { class: 'link-btn', text: 'Try again', onclick: () => this.show(place, modelSample, modelTimeLabel, modelAq) }));
    }
  }

  rerender() { if (this.last && this.data) this.show(this.last.place, this.last.modelSample, this.last.modelTimeLabel, this.last.modelAq); }

  _renderAq(box, a, model) {
    const c = a.current || {};
    if (c.us_aqi == null) {
      box.replaceChildren(el('p', { class: 'note', text: 'No air-quality estimate is available for this point.' }));
      return;
    }
    const cat = aqiCategory(c.us_aqi);
    const peak = Math.max(...(a.hourly?.us_aqi || []).filter((v) => v != null));
    const fmt = (v, unit = 'µg/m³') => (v == null ? '—' : `${Math.round(v)} ${unit}`);
    const stat = (k, v) => el('div', {}, el('dt', { text: k }), el('dd', { text: v }));
    box.replaceChildren(
      el('div', { class: 'aq-head' },
        el('div', { class: 'aq-score', text: String(Math.round(c.us_aqi)), title: 'US AQI' }),
        el('div', {},
          el('span', { class: 'aq-chip', style: `background:${cat.color}`, text: cat.name }),
          el('div', { class: 'note', style: 'margin-top:4px', text: `US AQI now${Number.isFinite(peak) ? ` · next 24 h peak ${Math.round(peak)}` : ''}` }))),
      el('p', { class: 'aq-advice', text: cat.advice }),
      el('dl', { class: 'aq-grid' },
        stat('PM2.5', fmt(c.pm2_5)), stat('PM10', fmt(c.pm10)), stat('Ozone', fmt(c.ozone)),
        stat('NO₂', fmt(c.nitrogen_dioxide)), stat('SO₂', fmt(c.sulphur_dioxide)), stat('European AQI', c.european_aqi == null ? '—' : String(Math.round(c.european_aqi)))),
      el('p', { class: 'note', text: `Air quality: CAMS forecast via Open-Meteo.${model ? ` Map layer (NOAA GEFS) here: AQI ${Math.round(model.aqi)}.` : ''} Model estimates, not station measurements.` }),
    );
  }

  _render(body, d, model, modelLabel) {
    const c = d.current;
    const stat = (k, v) => el('div', {}, el('dt', { text: k }), el('dd', { text: v }));
    body.replaceChildren(
      el('div', { class: 'now-row' },
        el('div', { class: 'now-temp', text: fmtTemp(c.temperature_2m) }),
        el('div', { class: 'now-desc' }, el('div', { text: WMO[c.weather_code] || '' }), el('div', { class: 'muted', text: `Feels like ${fmtTemp(c.apparent_temperature)}` }))),
      el('dl', { class: 'stats' },
        stat('Wind', `${fmtSpeedKmh(c.wind_speed_10m)} ${compass(c.wind_direction_10m)}`),
        stat('Gusts', fmtSpeedKmh(c.wind_gusts_10m)),
        stat('Humidity', `${c.relative_humidity_2m}%`),
        stat('Cloud', `${c.cloud_cover}%`),
        stat('Precip', `${c.precipitation} mm`),
        stat('Pressure', `${Math.round(c.pressure_msl)} hPa`)),
      this._charts(d),
      model ? el('p', { class: 'note', text: `Globe layer (GFS 1°) here at ${modelLabel}: ${fmtTemp(model.t2m, 1)}, wind ${fmtSpeedKmh(Math.hypot(model.u10, model.v10) * 3.6)}.` }) : null,
      el('p', { class: 'note', text: `Local forecast by Open-Meteo.com (CC BY 4.0) · times in ${d.timezone_abbreviation || d.timezone}` }),
    );
  }

  _charts(d) {
    const times = d.hourly.time;
    const temps = d.hourly.temperature_2m.map((v) => (v == null ? null : tempValue(v)));
    const pops = d.hourly.precipitation_probability;
    const W = 324, PADL = 30, PADR = 6, H1 = 92, H2 = 46, GAP = 22;
    const n = times.length;
    const x = (i) => PADL + (i / (n - 1)) * (W - PADL - PADR);
    const valid = temps.filter((v) => v != null);
    let lo = Math.floor(Math.min(...valid)), hi = Math.ceil(Math.max(...valid));
    if (hi - lo < 4) { const m = (hi + lo) / 2; lo = Math.floor(m - 2); hi = Math.ceil(m + 2); }
    const y = (v) => 8 + (1 - (v - lo) / (hi - lo)) * (H1 - 16);
    const y2 = (p) => H1 + GAP + (1 - p / 100) * H2;
    const NS = 'http://www.w3.org/2000/svg';
    const s = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
    const svg = s('svg', { viewBox: `0 0 ${W} ${H1 + GAP + H2 + 16}`, role: 'img', 'aria-label': `48-hour forecast: temperature from ${lo} to ${hi}${tempUnit()}, and chance of precipitation.` });
    const defs = s('defs', {});
    const grad = s('linearGradient', { id: 'tgrad', x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(s('stop', { offset: '0', 'stop-color': '#9ad1ff', 'stop-opacity': '0.22' }), s('stop', { offset: '1', 'stop-color': '#9ad1ff', 'stop-opacity': '0' }));
    defs.append(grad); svg.append(defs);
    // grid + y labels (temperature)
    const ticks = [lo, Math.round((lo + hi) / 2), hi];
    for (const t of ticks) {
      svg.append(s('line', { class: 'grid', x1: PADL, x2: W - PADR, y1: y(t), y2: y(t) }));
      const tx = s('text', { class: 'axis-label', x: PADL - 6, y: y(t) + 3, 'text-anchor': 'end' }); tx.textContent = `${t}°`; svg.append(tx);
    }
    const pl = s('text', { class: 'axis-label', x: PADL, y: H1 + GAP - 7 }); pl.textContent = 'Chance of precipitation'; svg.append(pl);
    for (const p of [0, 100]) {
      svg.append(s('line', { class: 'grid', x1: PADL, x2: W - PADR, y1: y2(p), y2: y2(p) }));
      const tx = s('text', { class: 'axis-label', x: PADL - 6, y: y2(p) + 3, 'text-anchor': 'end' }); tx.textContent = `${p}%`; svg.append(tx);
    }
    // x labels every 6 h, day boundary marks
    times.forEach((t, i) => {
      const hr = +t.slice(11, 13);
      if (hr % 6 === 0) {
        const tx = s('text', { class: 'axis-label', x: x(i), y: H1 + GAP + H2 + 13, 'text-anchor': 'middle' });
        tx.textContent = hr === 0 ? new Date(t + 'Z').toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }) : `${String(hr).padStart(2, '0')}h`;
        svg.append(tx);
      }
    });
    // temperature area + line
    let dLine = '', dArea = '';
    temps.forEach((v, i) => { if (v == null) return; const c = `${x(i).toFixed(1)},${y(v).toFixed(1)}`; dLine += (dLine ? 'L' : 'M') + c; });
    dArea = `${dLine}L${x(n - 1)},${H1}L${x(0)},${H1}Z`;
    svg.append(s('path', { class: 'area', d: dArea }), s('path', { class: 'series', d: dLine }));
    // precip bars, 2px gaps, rounded tops anchored on baseline
    const bw = Math.max(1, (W - PADL - PADR) / n - 2);
    pops.forEach((p, i) => {
      if (!p) return;
      const top = y2(p), h = y2(0) - top;
      svg.append(s('rect', { class: 'bar', x: (x(i) - bw / 2).toFixed(1), y: top.toFixed(1), width: bw.toFixed(1), height: Math.max(1, h).toFixed(1), rx: Math.min(1.5, bw / 2) }));
    });
    if (!pops.some((p) => p > 0)) {
      const nt = s('text', { class: 'axis-label', x: (PADL + W) / 2, y: y2(50) + 3, 'text-anchor': 'middle' });
      nt.textContent = 'No rain expected in the next 48 h';
      svg.append(nt);
    }
    // hover layer
    const xh = s('line', { class: 'xhair', y1: 4, y2: H1 + GAP + H2, visibility: 'hidden' });
    const dot = s('circle', { class: 'dot', r: 4, visibility: 'hidden' });
    const hit = s('rect', { class: 'hit', x: PADL - 6, y: 0, width: W - PADL - PADR + 12, height: H1 + GAP + H2 + 16 });
    svg.append(xh, dot, hit);
    const wrap = el('div', { class: 'chart' });
    const tip = el('div', { class: 'tip', hidden: true });
    const move = (e) => {
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - PADL) / (W - PADL - PADR)) * (n - 1))));
      const X = x(i);
      xh.setAttribute('x1', X); xh.setAttribute('x2', X); xh.setAttribute('visibility', 'visible');
      if (temps[i] != null) { dot.setAttribute('cx', X); dot.setAttribute('cy', y(temps[i])); dot.setAttribute('visibility', 'visible'); }
      const t = times[i];
      const day = new Date(t + 'Z').toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
      tip.innerHTML = `${day} ${t.slice(11, 16)} · <b>${temps[i] == null ? '—' : temps[i].toFixed(1) + tempUnit()}</b> · rain ${pops[i] ?? '—'}%`;
      tip.hidden = false;
      tip.style.left = `${Math.min(rect.width - 70, Math.max(70, (X / W) * rect.width))}px`;
    };
    const leave = () => { xh.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', leave);
    wrap.append(tip, svg);
    // accessible table alternative
    const table = el('table', { class: 'sr-only' }, el('caption', { text: '48-hour forecast' }),
      el('tr', {}, el('th', { text: 'Time' }), el('th', { text: `Temperature (${tempUnit()})` }), el('th', { text: 'Chance of precipitation (%)' })));
    times.forEach((t, i) => { if (i % 3 === 0) table.append(el('tr', {}, el('td', { text: t.replace('T', ' ') }), el('td', { text: temps[i]?.toFixed(1) ?? '—' }), el('td', { text: pops[i] ?? '—' }))); });
    return el('div', {},
      el('div', { class: 'chart-title' }, el('span', { text: `Next 48 hours · temperature (${tempUnit()})` })),
      wrap, table);
  }
}
