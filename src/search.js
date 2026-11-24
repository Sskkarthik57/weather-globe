// Place search (ARIA combobox):
//  - Photon (photon.komoot.io): OpenStreetMap search built for type-ahead -> villages, suburbs, landmarks,
//    streets, airports, peaks... Free, no key, fair use. Results are nudged toward the area on screen.
//  - Open-Meteo geocoding (GeoNames) in parallel, to fill in towns and cities and as a fallback.
//  - Coordinates ("17.385, 78.487", "33.9 S 151.2 E"), recent picks, highlighted matches, keyboard nav.
import { el, store, clamp, fmtLatLon } from './util.js';

const PHOTON = 'https://photon.komoot.io/api/';
const OM_GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const LIMIT = 10;
const RECENT_MAX = 6;

const KIND = { // Photon "osm_key:osm_value" -> label
  'place:country': 'Country', 'place:state': 'State', 'place:region': 'Region', 'place:province': 'Province',
  'place:county': 'County', 'place:district': 'District', 'place:city': 'City', 'place:town': 'Town',
  'place:village': 'Village', 'place:hamlet': 'Hamlet', 'place:suburb': 'Suburb', 'place:neighbourhood': 'Neighbourhood',
  'place:quarter': 'Quarter', 'place:locality': 'Locality', 'place:island': 'Island', 'place:islet': 'Island',
  'place:archipelago': 'Islands', 'boundary:administrative': 'Area', 'natural:peak': 'Peak', 'natural:volcano': 'Volcano',
  'natural:water': 'Lake', 'natural:bay': 'Bay', 'natural:beach': 'Beach', 'natural:glacier': 'Glacier',
  'aeroway:aerodrome': 'Airport', 'railway:station': 'Station', 'waterway:river': 'River', 'leisure:park': 'Park',
  'tourism:attraction': 'Attraction', 'amenity:university': 'University',
};
const GEONAMES = { // Open-Meteo feature_code -> label
  PPLC: 'Capital', PPLA: 'City', PPLA2: 'Town', PPLA3: 'Town', PPLA4: 'Town', PPL: 'Town', PPLX: 'Suburb',
  ADM1: 'State', ADM2: 'County', ADM3: 'Area', PCLI: 'Country', ISL: 'Island', MT: 'Mountain', PK: 'Peak',
  AIRP: 'Airport', LK: 'Lake',
};
const KIND_DIST = { // camera distance (Earth radii from the centre) when no bounding box is known
  Country: 3.0, State: 2.4, Region: 2.4, Province: 2.4, County: 2.0, Islands: 2.2, Island: 1.8, Capital: 1.8, City: 1.8,
  Town: 1.6, Area: 1.9, District: 1.7,
};
const titleCase = (s) => String(s).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function km(a, b) {
  const x = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(x, b.lat - a.lat) * 111.2;
}
const uniq = (parts, name) => [...new Set(parts.filter((p) => p && p !== name))];

function fromPhoton(f) {
  const p = f.properties || {};
  const [lon, lat] = f.geometry?.coordinates || [];
  const name = p.name || [p.street, p.housenumber].filter(Boolean).join(' ');
  if (!name || !Number.isFinite(lat)) return null;
  const kind = KIND[`${p.osm_key}:${p.osm_value}`] || (p.osm_key === 'highway' ? 'Street' : titleCase(p.osm_value || p.type || 'Place'));
  const big = ['Country', 'State', 'Region', 'Province'].includes(kind);
  const sub = uniq(big ? [p.country] : [p.locality || p.district, p.city || p.county, p.state, p.country], name).slice(-3).join(', ');
  let dist = KIND_DIST[kind] ?? 1.35;
  if (Array.isArray(p.extent)) {
    const [w, n, e, s] = p.extent;
    dist = clamp(1.22 + Math.max(Math.abs(e - w) * Math.cos(lat * Math.PI / 180), Math.abs(n - s)) * 0.045, 1.3, 3.4);
  }
  return { name, sub, lat, lon, kind, dist, src: 'osm' };
}

function fromOpenMeteo(r) {
  const code = r.feature_code || '';
  const kind = GEONAMES[code] || (code.startsWith('PPL') ? 'Town' : 'Place');
  return {
    name: r.name, sub: uniq([r.admin1, r.country], r.name).join(', '), lat: r.latitude, lon: r.longitude,
    kind, dist: KIND_DIST[kind] ?? 1.6, src: 'geonames',
  };
}

/** Photon first (it ranks by importance and knows far more places), Open-Meteo fills gaps; no near-duplicates. */
function merge(osm, gn) {
  const out = [];
  const same = (a, b) => (a.name.toLowerCase() === b.name.toLowerCase() && km(a, b) < 25) || km(a, b) < 0.3;
  const add = (r) => { if (out.length < LIMIT && !out.some((o) => same(o, r))) out.push(r); };
  osm.slice(0, 7).forEach(add);
  gn.forEach(add);
  osm.slice(7).forEach(add);
  return out;
}

/** "17.385, 78.487" · "17.385 78.487" · "33.87 S, 151.21 E" · "-33.87°, 151.21°" -> {lat, lon} */
export function parseCoords(q) {
  const m = q.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*°?\s*([EW])?$/i);
  if (!m) return null;
  let lat = +m[1], lon = +m[3];
  if (m[2]?.toUpperCase() === 'S') lat = -Math.abs(lat);
  if (m[4]?.toUpperCase() === 'W') lon = -Math.abs(lon);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * @param onPick  ({lat, lon, name?, sub?, dist?}) => void   (no name: the panel looks one up)
 * @param getBias () => ({lat, lon, zoom} | null)            area on screen, to rank nearby matches higher
 * @param local   (q) => [{name, sub, kind, river}]           instant offline matches (rivers), listed first;
 *                picking one calls onPick({river})
 */
export function initSearch(input, list, onPick, { getBias, local } = {}) {
  let timer = 0, ctrl = null, items = [], sel = -1, pickWhenReady = false, lastQuery = '';
  const cache = new Map();

  const setOpen = (open) => { list.hidden = !open; input.setAttribute('aria-expanded', String(open)); if (!open) { input.removeAttribute('aria-activedescendant'); sel = -1; } };
  const close = () => setOpen(false);
  const message = (text) => { items = []; list.replaceChildren(el('li', { class: 'msg', text, role: 'option', 'aria-disabled': 'true' })); setOpen(true); };
  const options = () => [...list.querySelectorAll('li[data-i]')];
  const highlight = (i) => {
    sel = i;
    options().forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
    if (i >= 0) { input.setAttribute('aria-activedescendant', `sr-${i}`); options()[i]?.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  };

  const recent = () => store.get('recent', []).filter((r) => r && Number.isFinite(r.lat) && r.name);
  const remember = (r) => {
    if (!r.name) return;
    const keep = { name: r.name, sub: r.sub, lat: r.lat, lon: r.lon, kind: r.kind, dist: r.dist };
    store.set('recent', [keep, ...recent().filter((o) => !(o.name === r.name && km(o, r) < 1))].slice(0, RECENT_MAX));
  };

  const pick = (i) => {
    const r = items[i];
    if (!r) return;
    input.value = r.name || fmtLatLon(r.lat, r.lon);
    clearTimeout(timer);
    ctrl?.abort(); // a slower online search must not reopen the list after a pick (rivers are listed before it returns)
    close();
    input.blur();
    if (r.river) { onPick({ river: r.river }); return; }
    remember(r);
    onPick({ lat: r.lat, lon: r.lon, name: r.name, sub: r.sub, dist: r.dist });
  };

  const nameWithMatch = (name, q) => {
    const k = q ? name.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (k < 0) return el('span', { class: 'sr-name', text: name });
    return el('span', { class: 'sr-name' }, name.slice(0, k), el('mark', { text: name.slice(k, k + q.length) }), name.slice(k + q.length));
  };

  const render = (results, q, heading) => {
    items = results;
    if (!results.length) { message(q ? 'No places found. Try a nearby town, or type coordinates like 17.38, 78.48' : 'Type a place name or coordinates'); return; }
    const rows = results.map((r, i) => el('li', {
      id: `sr-${i}`, role: 'option', 'aria-selected': 'false', 'data-i': String(i), class: r.river ? 'sr-river' : '',
      onpointerdown: (e) => { e.preventDefault(); pick(i); },
    },
    el('span', { class: 'sr-main' }, r.name ? nameWithMatch(r.name, q) : el('span', { class: 'sr-name', text: fmtLatLon(r.lat, r.lon) }),
      el('span', { class: 'sub', text: r.sub || '' })),
    r.kind ? el('span', { class: 'sr-kind', text: r.kind }) : null));
    const extra = [];
    if (heading) extra.push(el('li', { class: 'sr-head', role: 'presentation', text: heading }));
    const foot = heading === 'Recent'
      ? el('li', { class: 'sr-foot', role: 'presentation' }, el('button', {
        class: 'link-btn', type: 'button', text: 'Clear recent searches',
        onpointerdown: (e) => { e.preventDefault(); store.set('recent', []); close(); },
      }))
      : el('li', { class: 'sr-foot', role: 'presentation', text: `Places © OpenStreetMap contributors · GeoNames${results.some((r) => r.river) ? ' · Rivers: Natural Earth, Wikidata' : ''}` });
    list.replaceChildren(...extra, ...rows, foot);
    setOpen(true);
    highlight(-1);
    if (pickWhenReady) { pickWhenReady = false; pick(0); }
  };

  const showRecent = () => {
    const r = recent();
    if (r.length) render(r, '', 'Recent'); else close();
  };

  async function fetchPhoton(q, signal) {
    const params = new URLSearchParams({ q, limit: String(LIMIT), lang: 'en' });
    const b = getBias?.();
    if (b) {
      params.set('lat', b.lat.toFixed(3)); params.set('lon', b.lon.toFixed(3));
      params.set('zoom', String(b.zoom)); params.set('location_bias_scale', '0.15');
    }
    const r = await fetch(`${PHOTON}?${params}`, { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return ((await r.json()).features || []).map(fromPhoton).filter(Boolean);
  }
  async function fetchOpenMeteo(q, signal) {
    const r = await fetch(`${OM_GEO}?name=${encodeURIComponent(q)}&count=${LIMIT}&language=en&format=json`, { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return ((await r.json()).results || []).map(fromOpenMeteo);
  }

  const query = async (q) => {
    lastQuery = q;
    const coords = parseCoords(q);
    if (coords) { render([{ ...coords, name: null, sub: 'Coordinates', kind: 'Point', dist: 1.5 }], q); return; }
    const loc = local?.(q) || [];
    const b = getBias?.(); // results depend on the area on screen, so cache per area too
    const key = b ? `${q}|${b.lat.toFixed(1)},${b.lon.toFixed(1)},${b.zoom}` : q;
    if (cache.has(key)) { render([...loc, ...cache.get(key)], q); return; }
    ctrl?.abort();
    ctrl = new AbortController();
    const { signal } = ctrl;
    if (loc.length) { const pw = pickWhenReady; pickWhenReady = false; render(loc, q); pickWhenReady = pw; } // rivers show instantly
    else if (list.hidden || !items.length) message('Searching…');
    list.setAttribute('aria-busy', 'true');
    const [osm, gn] = await Promise.allSettled([fetchPhoton(q, signal), fetchOpenMeteo(q, signal)]);
    if (signal.aborted) return;
    list.removeAttribute('aria-busy');
    if (osm.status === 'rejected' && gn.status === 'rejected') {
      pickWhenReady = false;
      if (loc.length) render(loc, q);
      else message('Search is unavailable right now. Check your connection and try again.');
      return;
    }
    const res = merge(osm.value || [], gn.value || []);
    cache.set(key, res);
    if (input.value.trim() === q) render([...loc, ...res], q);
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    pickWhenReady = false;
    const q = input.value.trim();
    if (!q) { ctrl?.abort(); showRecent(); return; }
    if (q.length < 2) { ctrl?.abort(); close(); return; }
    timer = setTimeout(() => query(q), parseCoords(q) ? 0 : 250); // debounce: ~4 requests/second at most while typing
  });
  input.addEventListener('keydown', (e) => {
    const n = items.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.hidden) { if (!input.value.trim()) showRecent(); else if (n) setOpen(true); return; }
      if (n) highlight(Math.min(n - 1, sel + 1));
    } else if (e.key === 'ArrowUp' && !list.hidden) { e.preventDefault(); highlight(Math.max(-1, sel - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      if (!list.hidden && n && (q === lastQuery || !q)) pick(sel >= 0 ? sel : 0);
      else if (q.length >= 2) { clearTimeout(timer); pickWhenReady = true; query(q); } // pressed Enter before results arrived
    } else if (e.key === 'Escape') { if (!list.hidden) { e.stopPropagation(); close(); } else { input.value = ''; input.blur(); } }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('focus', () => {
    const q = input.value.trim();
    if (!q) showRecent();
    else if (items.length && q.length >= 2) render(items, q);
  });
}
