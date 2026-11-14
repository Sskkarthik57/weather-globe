// Shared helpers: colour ramps, units, geo maths, sun position, small storage wrapper.

export const DEG = Math.PI / 180;

// ---- colour ramps (sRGB hex). Temperature: cool -> neutral at 0 °C -> warm.
export const TEMP_RAMP = {
  min: -45, max: 46,
  stops: [
    [-45, '#1b0b3b'], [-35, '#3a1d8a'], [-25, '#2c4fc2'], [-15, '#2f8fd9'], [-5, '#8fd0ec'],
    [0, '#e6ecef'], [6, '#f7e3a0'], [14, '#f9c45c'], [22, '#f2913d'], [30, '#dc4c2c'], [38, '#a8172e'], [46, '#5c0a2a'],
  ],
};
// Wind speed (m/s): one hue, dark -> light (faster = brighter on the dark globe)
export const WIND_RAMP = {
  min: 0, max: 30,
  stops: [[0, '#31506e'], [5, '#4f7fb0'], [10, '#7fb6e6'], [16, '#b7e0ff'], [22, '#e4f4ff'], [30, '#ffffff']],
};
// Saffir–Simpson colours (conventional tropical-cyclone palette)
export const CYCLONE_COLORS = {
  TD: '#5ebaff', TS: '#00faf4', 'Cat 1': '#ffffcc', 'Cat 2': '#ffe775', 'Cat 3': '#ffc140', 'Cat 4': '#ff8f20', 'Cat 5': '#ff6060',
};
export const CYCLONE_NAMES = {
  TD: 'Tropical depression', TS: 'Tropical storm', 'Cat 1': 'Category 1', 'Cat 2': 'Category 2',
  'Cat 3': 'Category 3', 'Cat 4': 'Category 4', 'Cat 5': 'Category 5',
};

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Build a 256-entry RGBA Uint8Array sampling the ramp linearly between stops. */
export function rampPixels(ramp, n = 256) {
  const out = new Uint8Array(n * 4);
  const st = ramp.stops.map(([v, c]) => [v, hexToRgb(c)]);
  for (let i = 0; i < n; i++) {
    const v = ramp.min + (i / (n - 1)) * (ramp.max - ramp.min);
    let k = 0;
    while (k < st.length - 2 && v > st[k + 1][0]) k++;
    const [v0, c0] = st[k];
    const [v1, c1] = st[k + 1];
    const t = Math.min(1, Math.max(0, (v - v0) / (v1 - v0)));
    for (let j = 0; j < 3; j++) out[i * 4 + j] = Math.round(c0[j] + (c1[j] - c0[j]) * t);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function rampCss(ramp) {
  const span = ramp.max - ramp.min;
  return `linear-gradient(90deg, ${ramp.stops.map(([v, c]) => `${c} ${(((v - ramp.min) / span) * 100).toFixed(1)}%`).join(', ')})`;
}

// ---- units
const store = {
  get(k, d) { try { const v = localStorage.getItem('atmos.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('atmos.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
export { store };

export const units = { system: store.get('units', 'metric') };
export const fmtTemp = (c, digits = 0) => (c == null || Number.isNaN(c)) ? '—'
  : units.system === 'imperial' ? `${(c * 9 / 5 + 32).toFixed(digits)}°F` : `${c.toFixed(digits)}°C`;
export const tempValue = (c) => units.system === 'imperial' ? c * 9 / 5 + 32 : c;
export const tempUnit = () => units.system === 'imperial' ? '°F' : '°C';
export const fmtSpeedKmh = (kmh) => (kmh == null || Number.isNaN(kmh)) ? '—'
  : units.system === 'imperial' ? `${Math.round(kmh / 1.609)} mph` : `${Math.round(kmh)} km/h`;
export const speedValueMs = (ms) => units.system === 'imperial' ? ms * 2.23694 : ms * 3.6;
export const speedUnit = () => units.system === 'imperial' ? 'mph' : 'km/h';
const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => DIRS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

export function fmtLatLon(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}° ${ns}, ${Math.abs(lon).toFixed(2)}° ${ew}`;
}
export const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

// ---- geo <-> 3D (y up; lon 0 on +x; east toward -z)
export function latLonToVec3(lat, lon, r, out) {
  const la = lat * DEG, lo = lon * DEG, c = Math.cos(la);
  out.x = r * c * Math.cos(lo);
  out.y = r * Math.sin(la);
  out.z = -r * c * Math.sin(lo);
  return out;
}
export function vec3ToLatLon(v, out) {
  const len = Math.hypot(v.x, v.y, v.z);
  out.lat = Math.asin(v.y / len) / DEG;
  out.lon = Math.atan2(-v.z, v.x) / DEG;
  return out;
}

// ---- sun (low-precision almanac, good to ~0.1°)
export function subsolarPoint(date, out) {
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const g = (357.529 + 0.98560028 * d) * DEG;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const e = (23.439 - 0.00000036 * d) * DEG;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / DEG;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)) / DEG;
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  out.lat = dec;
  out.lon = wrapLon(ra - gmst * 15);
  return out;
}

export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---- time formatting
export function fmtValid(date) {
  return date.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
export function fmtRelHours(h) {
  if (Math.abs(h) < 0.5) return 'now';
  const a = Math.round(Math.abs(h));
  return h > 0 ? `in ${a} h` : `${a} h ago`;
}
export function fmtAgo(date) {
  const m = Math.round((Date.now() - date.getTime()) / 60000);
  if (m < 2) return 'just now';
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

// WMO weather interpretation codes (Open-Meteo)
export const WMO = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Light showers', 81: 'Showers',
  82: 'Violent showers', 85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm',
  96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail',
};
