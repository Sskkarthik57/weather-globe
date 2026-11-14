// Place search: Open-Meteo geocoding, debounced, cancels stale requests, ARIA combobox keyboard nav.
import { el } from './util.js';

const GEO = 'https://geocoding-api.open-meteo.com/v1/search';

export function initSearch(input, list, onPick) {
  let timer = 0, ctrl = null, items = [], sel = -1;
  const cache = new Map();

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); sel = -1; };
  const message = (text) => { list.replaceChildren(el('li', { class: 'msg', text, role: 'option', 'aria-disabled': 'true' })); list.hidden = false; input.setAttribute('aria-expanded', 'true'); };
  const highlight = (i) => {
    sel = i;
    [...list.children].forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
    if (i >= 0) { input.setAttribute('aria-activedescendant', `sr-${i}`); list.children[i]?.scrollIntoView({ block: 'nearest' }); }
  };
  const pick = (i) => {
    const r = items[i];
    if (!r) return;
    input.value = r.name;
    close();
    input.blur();
    onPick({ lat: r.latitude, lon: r.longitude, name: r.name, sub: [r.admin1, r.country].filter(Boolean).join(', ') });
  };
  const render = (results) => {
    items = results;
    if (!results.length) { message('No places found'); return; }
    list.replaceChildren(...results.map((r, i) => el('li', {
      id: `sr-${i}`, role: 'option', 'aria-selected': 'false',
      onpointerdown: (e) => { e.preventDefault(); pick(i); },
    }, el('span', { text: r.name }), el('span', { class: 'sub', text: [r.admin1, r.country].filter(Boolean).join(', ') }))));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    highlight(-1);
  };

  const query = async (q) => {
    if (cache.has(q)) { render(cache.get(q)); return; }
    ctrl?.abort();
    ctrl = new AbortController();
    try {
      const r = await fetch(`${GEO}?name=${encodeURIComponent(q)}&count=6&language=en&format=json`, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const res = j.results || [];
      cache.set(q, res);
      if (input.value.trim() === q) render(res);
    } catch (e) {
      if (e.name !== 'AbortError') message('Search is unavailable right now. Please try again.');
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { ctrl?.abort(); close(); return; }
    timer = setTimeout(() => query(q), 350); // debounce: at most ~3 requests/second while typing
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && items.length && !list.hidden) { e.preventDefault(); highlight(Math.min(items.length - 1, sel + 1)); }
    else if (e.key === 'ArrowUp' && !list.hidden) { e.preventDefault(); highlight(Math.max(0, sel - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (!list.hidden && items.length) pick(sel >= 0 ? sel : 0); }
    else if (e.key === 'Escape') { close(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('focus', () => { if (items.length && input.value.trim().length >= 2) render(items); });
}
