"""Build the static river layer: geometry from Natural Earth, facts from Wikidata.

Writes two files into public/rivers/ (committed to git; rivers don't change, so run this rarely):
  rivers.json   simplified river lines (delta-encoded), one entry per river
  details.json  per-river facts: source, mouth, tributaries, dams, length, discharge, ...

Usage:  .venv\\Scripts\\python.exe scripts\\build_rivers.py
Sources (both free):
  Natural Earth 1:10m rivers + lake centerlines, v5 (public domain)  https://www.naturalearthdata.com
  Wikidata (CC0)                                                     https://query.wikidata.org
"""
from __future__ import annotations

import io
import json
import math
import os
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "rivers")
CACHE = os.path.join(ROOT, "scripts", ".cache")
NE_URL = "https://naciscdn.org/naturalearth/10m/physical/ne_10m_rivers_lake_centerlines.zip"
SPARQL = "https://query.wikidata.org/sparql"
UA = {"User-Agent": "weather-globe-rivers-build/1.0 (open-source educational project)"}

SIMPLIFY_DEG = 0.008   # Douglas-Peucker tolerance (~0.9 km): invisible even at full zoom
QUANT = 1000           # coordinates stored as integer thousandths of a degree


# ----------------------------------------------------------------------------- download helpers
def fetch(url: str, data: bytes | None = None, headers: dict | None = None, timeout=120, tries=4) -> bytes:
    h = dict(UA, **(headers or {}))
    for k in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and k < tries - 1:
                wait = int(e.headers.get("Retry-After") or 0) or 5 * (k + 1)
                print(f"  HTTP {e.code}, retrying in {wait}s")
                time.sleep(wait)
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            if k < tries - 1:
                print(f"  {e}, retrying")
                time.sleep(5 * (k + 1))
                continue
            raise
    raise RuntimeError("unreachable")


def cached(name: str, url: str) -> bytes:
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, name)
    if not os.path.exists(p):
        print(f"Downloading {url}")
        b = fetch(url, headers={"User-Agent": "Mozilla/5.0"})
        with open(p, "wb") as f:
            f.write(b)
    with open(p, "rb") as f:
        return f.read()


# ----------------------------------------------------------------------------- shapefile reader
def read_dbf(b: bytes) -> list[dict]:
    n, hlen, rlen = struct.unpack("<xxxxIHH", b[:12])
    fields = []
    pos = 32
    while b[pos] != 0x0D:
        name = b[pos:pos + 11].split(b"\0")[0].decode("ascii")
        ftype = chr(b[pos + 11])
        flen = b[pos + 16]
        fields.append((name, ftype, flen))
        pos += 32
    rows = []
    for i in range(n):
        off = hlen + i * rlen + 1  # skip deletion flag
        row = {}
        for name, ftype, flen in fields:
            raw = b[off:off + flen]
            off += flen
            s = raw.decode("utf-8", "replace").replace("\0", " ").strip()
            if ftype in "NF":
                try:
                    row[name] = float(s) if s else None
                except ValueError:
                    row[name] = None
            else:
                row[name] = s or None
        rows.append(row)
    return rows


def read_shp_polylines(b: bytes) -> list[list[list[tuple[float, float]]]]:
    out = []
    pos = 100
    while pos < len(b):
        _, clen = struct.unpack(">II", b[pos:pos + 8])
        rec = b[pos + 8:pos + 8 + clen * 2]
        pos += 8 + clen * 2
        stype = struct.unpack("<i", rec[:4])[0]
        if stype == 0:
            out.append([])
            continue
        nparts, npts = struct.unpack("<ii", rec[36:44])
        parts = list(struct.unpack(f"<{nparts}i", rec[44:44 + 4 * nparts]))
        p0 = 44 + 4 * nparts
        xy = struct.unpack(f"<{npts * 2}d", rec[p0:p0 + 16 * npts])
        pts = [(xy[2 * i], xy[2 * i + 1]) for i in range(npts)]
        parts.append(npts)
        out.append([pts[parts[k]:parts[k + 1]] for k in range(nparts)])
    return out


def load_natural_earth():
    z = zipfile.ZipFile(io.BytesIO(cached("ne_10m_rivers_lake_centerlines.zip", NE_URL)))
    shp = z.read("ne_10m_rivers_lake_centerlines.shp")
    dbf = z.read("ne_10m_rivers_lake_centerlines.dbf")
    return read_dbf(dbf), read_shp_polylines(shp)


# ----------------------------------------------------------------------------- geometry
def simplify(pts: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    """Douglas-Peucker (iterative), in degrees with longitude scaled by cos(lat)."""
    n = len(pts)
    if n < 3:
        return pts
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    t2 = tol * tol
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        ax, ay = pts[a]
        bx, by = pts[b]
        c = math.cos(math.radians((ay + by) / 2))
        dx, dy = (bx - ax) * c, by - ay
        dd = dx * dx + dy * dy
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = (pts[i][0] - ax) * c, pts[i][1] - ay
            if dd == 0:
                d = px * px + py * py
            else:
                t = max(0.0, min(1.0, (px * dx + py * dy) / dd))
                ex, ey = px - t * dx, py - t * dy
                d = ex * ex + ey * ey
            if d > best:
                best, bi = d, i
        if best > t2:
            keep[bi] = True
            stack.append((a, bi))
            stack.append((bi, b))
    return [p for p, k in zip(pts, keep) if k]


def chain_lines(lines: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    """Join line pieces that share endpoints into long continuous polylines (only through
    simple joints where exactly two pieces meet, so confluences stay separate)."""
    key = lambda p: (round(p[0], 5), round(p[1], 5))
    lines = [list(l) for l in lines if len(l) >= 2]
    changed = True
    while changed:
        changed = False
        ends: dict = {}
        for i, l in enumerate(lines):
            ends.setdefault(key(l[0]), []).append((i, 0))
            ends.setdefault(key(l[-1]), []).append((i, 1))
        for k, lst in ends.items():
            if len(lst) != 2 or lst[0][0] == lst[1][0]:
                continue
            (i, ei), (j, ej) = lst
            a, b = lines[i], lines[j]
            if ei == 0:
                a = a[::-1]       # make a end at the joint
            if ej == 1:
                b = b[::-1]       # make b start at the joint
            lines[i] = a + b[1:]
            lines.pop(j)
            changed = True
            break
    return lines


def gc_dist(a, b) -> float:
    """Great-circle distance in degrees between (lon, lat) pairs."""
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    dlo = math.radians(b[0] - a[0])
    c = math.sin(la1) * math.sin(la2) + math.cos(la1) * math.cos(la2) * math.cos(dlo)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def encode(pts) -> list[int]:
    """Flat delta-encoded integer list: x0, y0, dx1, dy1, ..."""
    out, px, py = [], 0, 0
    for x, y in pts:
        qx, qy = round(x * QUANT), round(y * QUANT)
        out += [qx - px, qy - py]
        px, py = qx, qy
    return out


# ----------------------------------------------------------------------------- Wikidata
def sparql(query: str) -> list[dict]:
    body = urllib.parse.urlencode({"query": query}).encode()
    raw = fetch(SPARQL, data=body, headers={"Accept": "application/sparql-results+json",
                                            "Content-Type": "application/x-www-form-urlencoded"}, timeout=90)
    time.sleep(0.6)  # be polite to the public endpoint
    rows = json.loads(raw)["results"]["bindings"]
    return [{k: v["value"] for k, v in r.items()} for r in rows]


def qid(uri: str | None) -> str | None:
    return uri.rsplit("/", 1)[-1] if uri and "/entity/" in uri else None


def point(wkt: str | None):
    # "Point(lon lat)"; skip coordinates on other globes (Mars etc.)
    if not wkt or not wkt.startswith("Point("):
        return None
    lon, lat = wkt[6:-1].split()
    return [round(float(lon), 4), round(float(lat), 4)]


def num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def year(s):
    return int(s[:5].lstrip("+")) if s and s[:5].lstrip("+-").isdigit() else None


LABELS = 'SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul,fr,es,de,ru,zh,pt". }'
SOURCE, MOUTH = "Q7376362", "Q1233637"

Q_BASE = """SELECT ?r ?rLabel ?rDescription ?wp (GROUP_CONCAT(DISTINCT ?alt; separator="|") AS ?alts) WHERE {
  VALUES ?r { %s }
  OPTIONAL { ?wp schema:about ?r; schema:isPartOf <https://en.wikipedia.org/> . }
  OPTIONAL { ?r skos:altLabel ?alt . FILTER(LANG(?alt) = "en") }
  %s } GROUP BY ?r ?rLabel ?rDescription ?wp"""

Q_QUANT = """SELECT ?r ?p ?v ?rank ?part WHERE {
  VALUES ?r { %s }
  VALUES (?p ?pp ?pn) { ("len" p:P2043 psn:P2043) ("dis" p:P2225 psn:P2225) ("area" p:P2053 psn:P2053) ("ele" p:P2044 psn:P2044) }
  ?r ?pp ?st . ?st ?pn ?qv ; wikibase:rank ?rank . ?qv wikibase:quantityAmount ?v .
  OPTIONAL { ?st pq:P518 ?part }
}"""

Q_COUNTRY = """SELECT ?r ?c ?cLabel WHERE { VALUES ?r { %s } ?r wdt:P17 ?c . %s }"""

Q_COORD = """SELECT ?r ?part ?coord WHERE {
  VALUES ?r { %s } ?r p:P625 ?st . ?st ps:P625 ?coord . OPTIONAL { ?st pq:P518 ?part } }"""

Q_ORIGIN = """SELECT ?r ?o ?oLabel ?oDescription ?oc ?clsLabel ?rangeLabel ?admLabel ?ctyLabel ?ele WHERE {
  VALUES ?r { %s } ?r wdt:P885 ?o .
  OPTIONAL { ?o wdt:P625 ?oc } OPTIONAL { ?o wdt:P31 ?cls } OPTIONAL { ?o wdt:P4552 ?range }
  OPTIONAL { ?o wdt:P131 ?adm } OPTIONAL { ?o wdt:P17 ?cty }
  OPTIONAL { ?o p:P2044/psn:P2044/wikibase:quantityAmount ?ele }
  %s }"""

Q_MOUTH = """SELECT ?r ?m ?mLabel ?mDescription ?mc ?clsLabel WHERE {
  VALUES ?r { %s } ?r wdt:P403 ?m .
  OPTIONAL { ?m wdt:P625 ?mc } OPTIONAL { ?m wdt:P31 ?cls }
  %s }"""

Q_TRIB = """SELECT ?r ?t ?tLabel ?sideLabel ?tlen ?tmc ?tc WHERE {
  VALUES ?r { %s }
  { ?r p:P974 ?st . ?st ps:P974 ?t . OPTIONAL { ?st pq:P3871 ?side } } UNION { ?t wdt:P403 ?r . }
  OPTIONAL { ?t p:P2043/psn:P2043/wikibase:quantityAmount ?tlen }
  OPTIONAL { ?t p:P625 ?tcs . ?tcs ps:P625 ?tmc ; pq:P518 wd:%s . }
  OPTIONAL { ?t wdt:P625 ?tc }
  %s }"""

# dams, barrages, weirs and hydro power stations on the river. Wikidata links them three ways:
# P206 (located in or next to body of water), P706 (located on terrain feature), P177 (crosses)
Q_DAM = """SELECT ?r ?d ?dLabel ?dDescription ?dc ?clsLabel ?h ?len ?cap ?inc ?open ?resLabel ?ctyLabel ?useLabel ?wp WHERE {
  VALUES ?r { %s }
  ?d wdt:P206|wdt:P706|wdt:P177 ?r . ?d wdt:P31 ?cls .
  VALUES ?top { wd:Q12323 wd:Q15911738 wd:Q1066997 wd:Q350495 }
  ?cls wdt:P279* ?top .
  OPTIONAL { ?d wdt:P625 ?dc }
  OPTIONAL { ?d p:P2048/psn:P2048/wikibase:quantityAmount ?h }
  OPTIONAL { ?d p:P2043/psn:P2043/wikibase:quantityAmount ?len }
  OPTIONAL { ?d p:P2109/psn:P2109/wikibase:quantityAmount ?cap }
  OPTIONAL { ?d wdt:P571 ?inc } OPTIONAL { ?d wdt:P1619 ?open }
  OPTIONAL { ?d wdt:P4661 ?res } OPTIONAL { ?d wdt:P17 ?cty } OPTIONAL { ?d wdt:P366 ?use }
  OPTIONAL { ?wp schema:about ?d; schema:isPartOf <https://en.wikipedia.org/> . }
  %s }"""


def run_batched(template: str, ids: list[str], *extra, size=60) -> list[dict]:
    rows = []
    for i in range(0, len(ids), size):
        vals = " ".join("wd:" + q for q in ids[i:i + size])
        q = template % ((vals,) + extra)
        try:
            rows += sparql(q)
        except Exception as e:  # split a failing batch (timeouts on huge rivers) before giving up
            if isinstance(e, urllib.error.HTTPError) and e.code == 400:
                raise RuntimeError("SPARQL syntax error:\n" + e.read().decode("utf-8", "replace")[:600]) from e
            if size > 5:
                print(f"  batch failed ({e}); splitting")
                rows += run_batched(template, ids[i:i + size], *extra, size=max(5, size // 4))
            else:
                print(f"  giving up on {ids[i:i + size]}: {e}")
    return rows


def add_once(lst: list, item: dict, key="q"):
    if item.get(key) is None or all(x.get(key) != item[key] for x in lst):
        lst.append(item)


def fetch_wikidata(ids: list[str]) -> dict:
    D = {q: {"q": q, "countries": [], "origin": [], "mouth": [], "tribs": [], "dams": []} for q in ids}

    print("Wikidata: names")
    for r in run_batched(Q_BASE, ids, LABELS):
        d = D[qid(r["r"])]
        d["name"] = r.get("rLabel")
        d["desc"] = r.get("rDescription")
        if r.get("wp"):
            d["wiki"] = urllib.parse.unquote(r["wp"].rsplit("/", 1)[-1])
        if r.get("alts"):
            d["alt"] = [a for a in r["alts"].split("|") if a and a != d["name"]][:6]

    print("Wikidata: length, discharge, basin, elevation")
    best: dict = {}
    for r in run_batched(Q_QUANT, ids):
        q, p, v = qid(r["r"]), r["p"], num(r["v"])
        part = qid(r.get("part"))
        if v is None or r["rank"].endswith("Deprecated"):
            continue
        if p == "ele":
            p = {SOURCE: "srcEle", MOUTH: "mouthEle"}.get(part)
            if not p:
                continue
        elif part and p != "len":  # e.g. discharge "at a station": keep only whole-river values
            continue
        # length: the longest stated (e.g. Nile 6650 km incl. White Nile, not the 2850 km below Khartoum);
        # other quantities: the preferred statement, which is the long-term mean rather than a flood peak
        score = (v,) if p == "len" else (r["rank"].endswith("Preferred"), v)
        if (q, p) not in best or score > best[(q, p)]:
            best[(q, p)] = score
    for (q, p), score in best.items():
        v = score[-1]
        D[q][p] = round(v / 1000, 1) if p == "len" else round(v / 1e6) if p == "area" else round(v, 1)

    print("Wikidata: countries")
    for r in run_batched(Q_COUNTRY, ids, LABELS):
        name = r.get("cLabel")
        if name and name not in D[qid(r["r"])]["countries"]:
            D[qid(r["r"])]["countries"].append(name)

    print("Wikidata: source / mouth coordinates")
    for r in run_batched(Q_COORD, ids):
        part, pt = qid(r.get("part")), point(r.get("coord"))
        if pt and part == SOURCE:
            D[qid(r["r"])].setdefault("srcPt", pt)
        elif pt and part == MOUTH:
            D[qid(r["r"])].setdefault("mouthPt", pt)

    print("Wikidata: origins")
    for r in run_batched(Q_ORIGIN, ids, LABELS):
        lst = D[qid(r["r"])]["origin"]
        o = qid(r["o"])
        cur = next((x for x in lst if x["q"] == o), None)
        if not cur:
            cur = {"q": o, "name": r.get("oLabel"), "desc": r.get("oDescription")}
            lst.append(cur)
        for k, src in (("pt", point(r.get("oc"))), ("type", r.get("clsLabel")), ("range", r.get("rangeLabel")),
                       ("admin", r.get("admLabel")), ("country", r.get("ctyLabel")), ("ele", num(r.get("ele")))):
            if src is not None and cur.get(k) is None and not (isinstance(src, str) and src.startswith("Q") and src[1:].isdigit()):
                cur[k] = round(src) if k == "ele" else src

    print("Wikidata: mouths")
    for r in run_batched(Q_MOUTH, ids, LABELS):
        lst = D[qid(r["r"])]["mouth"]
        m = qid(r["m"])
        cur = next((x for x in lst if x["q"] == m), None)
        if not cur:
            cur = {"q": m, "name": r.get("mLabel"), "desc": r.get("mDescription")}
            lst.append(cur)
        if cur.get("pt") is None and point(r.get("mc")):
            cur["pt"] = point(r.get("mc"))
        if cur.get("type") is None and r.get("clsLabel"):
            cur["type"] = r["clsLabel"]

    print("Wikidata: tributaries")
    for r in run_batched(Q_TRIB, ids, MOUTH, LABELS, size=25):
        lst = D[qid(r["r"])]["tribs"]
        t = qid(r["t"])
        name = r.get("tLabel")
        if not name or (name.startswith("Q") and name[1:].isdigit()):
            continue
        cur = next((x for x in lst if x["q"] == t), None)
        if not cur:
            cur = {"q": t, "name": name}
            lst.append(cur)
        side = (r.get("sideLabel") or "").lower()
        if "left" in side:
            cur["side"] = "L"
        elif "right" in side:
            cur["side"] = "R"
        if r.get("tlen") and not cur.get("len"):
            cur["len"] = round(num(r["tlen"]) / 1000)
        pt = point(r.get("tmc")) or point(r.get("tc"))
        if pt and not cur.get("pt"):
            cur["pt"] = pt

    print("Wikidata: dams")
    for r in run_batched(Q_DAM, ids, LABELS, size=40):
        lst = D[qid(r["r"])]["dams"]
        dq = qid(r["d"])
        name = r.get("dLabel")
        if not name or (name.startswith("Q") and name[1:].isdigit()):
            continue
        cur = next((x for x in lst if x["q"] == dq), None)
        if not cur:
            cur = {"q": dq, "name": name}
            lst.append(cur)
        vals = (("pt", point(r.get("dc"))), ("type", r.get("clsLabel")), ("desc", r.get("dDescription")),
                ("height", num(r.get("h"))), ("length", num(r.get("len"))), ("mw", num(r.get("cap"))),
                ("year", year(r.get("open")) or year(r.get("inc"))), ("reservoir", r.get("resLabel")),
                ("country", r.get("ctyLabel")), ("use", r.get("useLabel")),
                ("wiki", urllib.parse.unquote(r["wp"].rsplit("/", 1)[-1]) if r.get("wp") else None))
        for k, v in vals:
            if v is None or cur.get(k) is not None:
                continue
            if k == "mw":
                v = round(v / 1e6, 1)       # watts -> MW
            elif k in ("height", "length"):
                v = round(v)
            cur[k] = v
    return D


# ----------------------------------------------------------------------------- build
def main():
    rows, geoms = load_natural_earth()
    groups: dict[str, dict] = {}
    for row, parts in zip(rows, geoms):
        if not parts:
            continue
        q = row.get("wikidataid")
        name = row.get("name")
        key = q or (f"n:{name}:{int(row.get('rivernum') or 0)}" if name else f"u:{int(row.get('ne_id') or 0)}")
        g = groups.setdefault(key, {"q": q, "name": name, "rank": 99, "lines": [], "lake": 0})
        g["rank"] = min(g["rank"], int(row.get("scalerank") or 9))
        g["lines"] += parts
        if row.get("featurecla") == "Lake Centerline":
            g["lake"] += 1
    print(f"{len(rows)} Natural Earth features -> {len(groups)} rivers")

    ids = sorted({g["q"] for g in groups.values() if g["q"]})
    wd_cache = os.path.join(CACHE, "wikidata.json")
    if "--reuse" in sys.argv and os.path.exists(wd_cache):
        print("Reusing Wikidata answers from", wd_cache)  # only re-process geometry (seconds instead of minutes)
        with open(wd_cache, encoding="utf-8") as f:
            D = json.load(f)
    else:
        D = fetch_wikidata(ids)
        os.makedirs(CACHE, exist_ok=True)
        with open(wd_cache, "w", encoding="utf-8") as f:
            json.dump(D, f, ensure_ascii=False)
    for q in ids:
        D.setdefault(q, {"q": q, "countries": [], "origin": [], "mouth": [], "tribs": [], "dams": []})

    # endpoints of every river, used to find which end of a river touches another river (= its mouth)
    def end_key(p):
        return (round(p[0], 3), round(p[1], 3))

    chains_by_key = {k: chain_lines(g["lines"]) for k, g in groups.items()}
    vertex_owner: dict = {}
    for k, chains in chains_by_key.items():
        for c in chains:
            for p in c:
                vertex_owner.setdefault(end_key(p), set()).add(k)
    key_by_q = {g["q"]: k for k, g in groups.items() if g["q"]}

    def dist_to_river(p, k2) -> float:
        """Distance (degrees) from point p to the nearest vertex of river k2's line."""
        return min(gc_dist(p, v) for c in chains_by_key[k2] for v in c[::2] + [c[-1]])

    rivers, details = [], {}
    nverts = 0
    for k, g in sorted(groups.items(), key=lambda kv: (kv[1]["rank"], kv[1]["name"] or "~")):
        d = D.get(g["q"]) if g["q"] else None
        chains = chains_by_key[k]
        # reference points for orientation (most reliable first)
        mouth_ref = (d or {}).get("mouthPt")
        src_ref = (d or {}).get("srcPt") or next((o["pt"] for o in (d or {}).get("origin", []) if o.get("pt")), None)
        mouth_item = next((m["pt"] for m in (d or {}).get("mouth", []) if m.get("pt")), None)
        # drains into another drawn river (e.g. Brahmaputra -> Ganges): the mouth is the end touching it
        mouth_river = next((key_by_q[m["q"]] for m in (d or {}).get("mouth", []) if m.get("q") in key_by_q and key_by_q[m["q"]] != k), None)
        oriented = []
        for c in chains:
            a, b = c[0], c[-1]
            # majority vote of the independent hints (any one of them can be wrong in Wikidata)
            votes = []
            if mouth_ref:
                votes.append(gc_dist(a, mouth_ref) < gc_dist(b, mouth_ref))
            if mouth_river and abs(dist_to_river(a, mouth_river) - dist_to_river(b, mouth_river)) > 0.05:
                votes.append(dist_to_river(a, mouth_river) < dist_to_river(b, mouth_river))
            if src_ref:
                votes.append(gc_dist(a, src_ref) > gc_dist(b, src_ref))
            rev = None
            if votes and votes.count(True) != votes.count(False):
                rev = votes.count(True) > votes.count(False)
            elif votes:
                rev = votes[0]
            else:
                ta = len(vertex_owner.get(end_key(a), ())) > 1   # this end joins another river
                tb = len(vertex_owner.get(end_key(b), ())) > 1
                if ta != tb:
                    rev = ta
                elif mouth_item:
                    rev = gc_dist(a, mouth_item) < gc_dist(b, mouth_item)
            if rev:
                c = c[::-1]
            s = simplify(c, SIMPLIFY_DEG)
            if len(s) >= 2:
                oriented.append(s)
        if not oriented:
            continue
        nverts += sum(len(c) for c in oriented)
        name = (d or {}).get("name") or g["name"]
        rec = {"q": g["q"], "n": name, "r": g["rank"], "p": [encode(c) for c in oriented]}
        if d and d.get("alt"):
            rec["a"] = d["alt"]
        rivers.append(rec)
        if d:
            # where the drawn line ends: the downstream end of the longest chain
            longest = max(oriented, key=len)
            d["lineEnd"] = [round(longest[-1][0], 3), round(longest[-1][1], 3)]
            d["lineStart"] = [round(longest[0][0], 3), round(longest[0][1], 3)]
            d["rank"] = g["rank"]
            # biggest tributaries first (those drawn on the globe before others); big rivers like the
            # Columbia list hundreds of creeks, so keep the 40 most significant and remember the total
            drawn = {g2["q"] for g2 in groups.values() if g2["q"]}
            d["tribs"].sort(key=lambda t: (t["q"] not in drawn, -(t.get("len") or 0), t["name"]))
            if len(d["tribs"]) > 40:
                d["tribTotal"] = len(d["tribs"])
                d["tribs"] = d["tribs"][:40]
            # dams in downstream order is nicest, but we only know positions; sort by height (biggest first)
            d["dams"].sort(key=lambda t: (-(t.get("height") or 0), -(t.get("mw") or 0), t["name"]))
            details[g["q"]] = {k2: v for k2, v in d.items() if v not in (None, [], "")}

    os.makedirs(OUT, exist_ok=True)
    meta = {"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "quant": QUANT,
            "sources": ["Natural Earth 10m rivers v5 (public domain)", "Wikidata (CC0)"]}
    with open(os.path.join(OUT, "rivers.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "rivers": rivers}, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(OUT, "details.json"), "w", encoding="utf-8") as f:
        json.dump(details, f, ensure_ascii=False, separators=(",", ":"))
    nd = sum(len(v.get("dams", [])) for v in details.values())
    nt = sum(len(v.get("tribs", [])) for v in details.values())
    print(f"Wrote {len(rivers)} rivers, {nverts} vertices, {len(details)} with details, {nt} tributaries, {nd} dams")
    for fn in ("rivers.json", "details.json"):
        print(f"  {fn}: {os.path.getsize(os.path.join(OUT, fn)) / 1e6:.2f} MB")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--test":  # quick check of every query on a few rivers
        out = fetch_wikidata(sys.argv[2:] or ["Q5089", "Q193499", "Q3392", "Q2251"])
        print(json.dumps(out, ensure_ascii=False, indent=1)[:12000])
    else:
        main()
