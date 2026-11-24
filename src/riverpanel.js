// River details panel: Wikipedia photo + summary (live), stats, source -> mouth journey,
// tributaries and dams (baked from Wikidata by scripts/build_rivers.py).
import { el, fmtLatLon, units } from './util.js';
import { RIVER_COLORS } from './rivers.js';

const WIKI = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const wikiCache = new Map();

const fmtKm = (km) => km == null ? null : units.system === 'imperial'
  ? `${Math.round(km / 1.609).toLocaleString()} mi` : `${Math.round(km).toLocaleString()} km`;
const fmtArea = (km2) => km2 == null ? null : units.system === 'imperial'
  ? `${Math.round(km2 / 2.59).toLocaleString()} mi²` : `${Math.round(km2).toLocaleString()} km²`;
const fmtM = (m) => m == null ? null : units.system === 'imperial' ? `${Math.round(m * 3.281).toLocaleString()} ft` : `${Math.round(m).toLocaleString()} m`;
const fmtFlow = (q) => q == null ? null : units.system === 'imperial'
  ? `${Math.round(q * 35.31).toLocaleString()} ft³/s` : `${Math.round(q).toLocaleString()} m³/s`;
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
const ll = (pt) => fmtLatLon(pt[1], pt[0]);

function wikiSummary(title) {
  if (!wikiCache.has(title)) {
    const p = fetch(WIKI + encodeURIComponent(title), { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    wikiCache.set(title, p);
  }
  return wikiCache.get(title);
}

export class RiverPanel {
  /** handlers: { fly(lat, lon, dist), selectQ(qid), dam(index, dam) } */
  constructor(root, handlers) { this.root = root; this.h = handlers; this.last = null; }

  rerender() { if (this.last) this.show(...this.last); }

  loading(name) {
    this.root.replaceChildren(el('h2', { class: 'place-title', text: name || 'River' }),
      el('div', { class: 'skeleton', style: 'height:150px' }), el('div', { class: 'skeleton' }), el('div', { class: 'skeleton', style: 'width:60%' }));
  }

  error(name, msg, retry) {
    this.root.replaceChildren(el('h2', { class: 'place-title', text: name || 'River' }),
      el('p', { class: 'err', text: 'River details couldn’t be loaded.' }), el('p', { class: 'note', text: msg }),
      retry ? el('button', { class: 'link-btn', text: 'Try again', onclick: retry }) : null);
  }

  /** rv: river from Rivers; d: details (may be null for rivers without a Wikidata entry);
   *  ends: {src, mouth} as [lon, lat]; resolve(q) -> river or null; details: all details (for drain chain) */
  show(rv, d, ends, resolve, details) {
    this.last = [rv, d, ends, resolve, details];
    const r = this.root;
    r.replaceChildren();
    r.scrollTop = 0;
    const name = d?.name || rv.name;

    // ---- hero: Wikipedia photo + summary (loads after the rest is shown)
    const hero = el('div', { class: 'rv-hero' }, el('div', { class: 'skeleton rv-hero-skel' }));
    const extract = el('p', { class: 'rv-extract' });
    if (d?.wiki) {
      wikiSummary(d.wiki).then((w) => {
        if (this.last?.[0] !== rv) return;
        const src = w?.originalimage?.source && w.originalimage.width <= 1400 ? w.originalimage.source : w?.thumbnail?.source;
        if (src) {
          const img = el('img', { alt: `${name}`, loading: 'eager', decoding: 'async' });
          img.onload = () => { hero.replaceChildren(img); requestAnimationFrame(() => img.classList.add('in')); };
          img.onerror = () => hero.remove();
          img.src = src;
        } else hero.remove();
        if (w?.extract) {
          extract.textContent = w.extract;
          extract.append(' ', el('a', { href: w.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(d.wiki)}`, target: '_blank', rel: 'noopener', text: 'Wikipedia ↗' }));
          if (w.extract.length > 260) { // long summaries: 4 lines + "More", so the journey stays in view
            extract.classList.add('clamp');
            const more = el('button', { class: 'link-btn rv-more', text: 'More', 'aria-expanded': 'false' });
            more.onclick = () => { const open = extract.classList.toggle('clamp') === false; more.textContent = open ? 'Less' : 'More'; more.setAttribute('aria-expanded', String(open)); };
            extract.after(more);
          }
        } else extract.remove();
      });
    } else { hero.remove(); extract.remove(); }

    const subtitle = [cap(d?.desc), d?.countries?.length ? d.countries.join(', ') : null].filter(Boolean).join(' · ') || 'River';
    r.append(hero,
      el('div', { class: 'rv-title-row' },
        el('span', { class: 'rv-swatch', style: `background:${RIVER_COLORS.selected}` }),
        el('h2', { class: 'place-title', text: name })),
      el('div', { class: 'place-sub', text: subtitle }),
      extract);

    if (!d) {
      r.append(el('p', { class: 'note', text: 'No further facts are recorded for this river in Wikidata yet.' }));
      return;
    }

    // ---- stats
    const stats = [['Length', fmtKm(d.len)], ['Avg. flow', fmtFlow(d.dis)], ['Basin', fmtArea(d.area)],
      ['Source elev.', fmtM(d.origin?.find((o) => o.ele != null)?.ele ?? d.srcEle)], ['Tributaries', d.tribTotal || d.tribs?.length || null], ['Dams', d.dams?.length || null]]
      .filter(([, v]) => v != null);
    if (stats.length) {
      r.append(el('dl', { class: 'stats' }, ...stats.map(([k, v]) => el('div', {}, el('dt', { text: k }), el('dd', { text: String(v) })))));
    }

    // ---- journey: source -> mouth
    const o = d.origin?.[0];
    const m = d.mouth?.[0];
    const srcBits = o ? [cap(o.type), o.range ? `${o.range}` : null, [o.admin, o.country].filter(Boolean).join(', ') || null, o.ele != null ? fmtM(o.ele) : null] : [];
    const chain = [];
    let cur = d; const seen = new Set([d.q]);
    while (cur?.mouth?.[0] && chain.length < 5) {
      const mm = cur.mouth[0];
      chain.push(mm);
      if (seen.has(mm.q)) break;
      seen.add(mm.q);
      cur = details?.[mm.q];
    }
    const mouthRiver = m ? resolve(m.q) : null;
    const step = (cls, icon, label, title, lines, pt, extra) => el('li', { class: `rv-step ${cls}` },
      el('span', { class: 'rv-dot', 'aria-hidden': 'true' }, icon),
      el('div', {},
        el('div', { class: 'rv-step-label', text: label }),
        el('div', { class: 'rv-step-title', text: title }),
        ...lines.filter(Boolean).map((t) => el('div', { class: 'rv-step-meta', text: t })),
        pt ? el('button', { class: 'chip-btn', text: `Show on globe · ${ll(pt)}`, onclick: () => this.h.fly(pt[1], pt[0], 1.6) }) : null,
        extra || null));
    const iconSrc = el('span'); iconSrc.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 19l6.5-11 3.5 6 2-3 6 8z"/></svg>';
    const iconMouth = el('span'); iconMouth.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 9c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/></svg>';
    const flow = [d.countries?.length ? `Flows through ${d.countries.join(', ')}` : null,
      d.len ? `${fmtKm(d.len)} long` : null].filter(Boolean).join(' · ');
    r.append(el('div', { class: 'rv-section', text: 'Journey' }),
      el('ol', { class: 'rv-journey' },
        step('src', iconSrc, 'Originates at', o?.name || 'Source', o ? [cap(o.desc), srcBits.filter(Boolean).join(' · ')] : ['Source not named in Wikidata'], ends.src),
        flow ? el('li', { class: 'rv-step mid' }, el('span', { class: 'rv-dot', 'aria-hidden': 'true' }), el('div', { class: 'rv-step-meta', text: flow })) : null,
        step('mouth', iconMouth, m ? 'Drains into' : 'Ends at', m?.name || 'Mouth', [cap(m?.desc),
          chain.length > 1 ? `Water path: ${name} → ${chain.map((c) => c.name).join(' → ')}` : null], ends.mouth,
          mouthRiver ? el('button', { class: 'chip-btn accent', text: `Open ${mouthRiver.name} →`, onclick: () => this.h.selectQ(m.q) }) : null)));

    // ---- tributaries
    if (d.tribs?.length) {
      const total = d.tribTotal || d.tribs.length;
      r.append(el('div', { class: 'rv-section' }, el('span', { text: `Tributaries · ${total}` }),
        el('span', { class: 'rv-key' }, el('i', { style: `background:${RIVER_COLORS.trib}` }), 'on the map')));
      const ul = el('ul', { class: 'rv-tribs' });
      for (const t of d.tribs) {
        const drawn = resolve(t.q);
        const meta = [t.side === 'L' ? 'left bank' : t.side === 'R' ? 'right bank' : null, fmtKm(t.len)].filter(Boolean).join(' · ');
        ul.append(el('li', {}, el('button', {
          class: drawn ? 'drawn' : '', title: drawn ? `Open ${t.name}` : t.pt ? 'Show where it joins' : '',
          disabled: !drawn && !t.pt,
          onclick: () => (drawn ? this.h.selectQ(t.q) : this.h.fly(t.pt[1], t.pt[0], 1.5)),
        }, el('span', { class: 'rv-trib-name', text: t.name }), meta ? el('span', { class: 'rv-trib-meta', text: meta }) : null)));
      }
      r.append(ul);
      if (d.tribTotal) r.append(el('p', { class: 'note', text: `Showing the ${d.tribs.length} largest of ${total}.` }));
    }

    // ---- dams
    r.append(el('div', { class: 'rv-section' }, el('span', { text: `Dams & barrages · ${d.dams?.length || 0}` }),
      d.dams?.length ? el('span', { class: 'rv-key' }, el('i', { class: 'sq', style: `background:${RIVER_COLORS.dam}` }), 'on the map') : null));
    if (d.dams?.length) {
      const ul = el('ul', { class: 'rv-dams' });
      d.dams.forEach((dam, k) => {
        const facts = [dam.height ? `${fmtM(dam.height)} high` : null, dam.length ? `${fmtM(dam.length)} long` : null,
          dam.mw ? `${dam.mw.toLocaleString()} MW` : null, dam.year ? `since ${dam.year}` : null].filter(Boolean);
        const sub = [cap(dam.type), dam.country].filter(Boolean).join(' · ');
        const btn = el('button', { disabled: !dam.pt, onclick: () => { this.h.dam(k, dam); this._activeDam(ul, k); } },
          el('span', { class: 'rv-dam-icon', 'aria-hidden': 'true' }),
          el('span', {},
            el('div', { class: 'storm-name', text: dam.name }),
            sub ? el('div', { class: 'storm-meta', text: sub }) : null,
            facts.length ? el('div', { class: 'rv-dam-facts' }, ...facts.map((f) => el('span', { text: f }))) : null,
            dam.reservoir ? el('div', { class: 'storm-meta', text: `Reservoir: ${dam.reservoir}` }) : null,
            dam.use ? el('div', { class: 'storm-meta', text: `Use: ${dam.use}` }) : null));
        const li = el('li', { 'data-k': String(k) }, btn);
        if (dam.wiki) li.append(el('a', { class: 'rv-dam-link', href: `https://en.wikipedia.org/wiki/${encodeURIComponent(dam.wiki)}`, target: '_blank', rel: 'noopener', 'aria-label': `${dam.name} on Wikipedia`, text: '↗' }));
        ul.append(li);
      });
      r.append(ul);
    } else {
      r.append(el('p', { class: 'note', style: 'margin-top:0', text: 'No dams on this river are recorded in Wikidata.' }));
    }

    r.append(el('p', { class: 'note', text: 'River lines: Natural Earth (public domain). Facts: Wikidata (CC0), which is community-edited and may be incomplete. Photo and summary: Wikipedia (CC BY-SA).' }));
  }

  /** Highlight dam k in the list (from a click on its marker) and scroll it into view. */
  focusDam(k) {
    const ul = this.root.querySelector('.rv-dams');
    if (ul) this._activeDam(ul, k, true);
  }

  _activeDam(ul, k, scroll) {
    for (const li of ul.children) li.classList.toggle('active', li.dataset.k === String(k));
    if (scroll) ul.querySelector(`[data-k="${k}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
