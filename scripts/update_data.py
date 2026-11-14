"""Download fresh weather data for the globe.

Outputs (in public/data/):
  meta.json            run time, forecast steps, value ranges, source status
  gfs_fXXX.png         one RGB image per forecast hour:
                         R = 2 m temperature, G = 10 m wind U, B = 10 m wind V
                         (8-bit, linearly scaled using ranges in meta.json)
  cyclones.geojson     active (and recently ended) tropical cyclones from GDACS

Sources:
  NOAA GFS 1.0 deg via the NOAA Open Data Dissemination program on AWS
    (https://registry.opendata.aws/noaa-gfs-bdp-pds/), falling back to NOMADS.
  GDACS tropical cyclone API (https://www.gdacs.org).

Usage:  python scripts/update_data.py [--hours 72] [--step 6]
Only needs numpy and pillow (no compiled GRIB library).
"""
import argparse
import datetime as dt
import json
import math
import os
import shutil
import sys
import time
import urllib.error
import urllib.request

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grib2 import decode_messages  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "data")
UA = {"User-Agent": "weather-globe-data-pipeline/1.0 (open-source educational project)"}
AWS = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
NOMADS = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl"
GDACS_LIST = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC"
RECENT_DAYS = 14

WANTED = {  # (category, parameter, level) -> key
    (0, 0, 2.0): "t2m",
    (2, 2, 10.0): "u10",
    (2, 3, 10.0): "v10",
}
IDX_KEYS = {"TMP:2 m above ground": "t2m", "UGRD:10 m above ground": "u10", "VGRD:10 m above ground": "v10"}


def log(*a):
    print(*a, flush=True)


def http(url, headers=None, timeout=60, retries=3, method="GET"):
    h = dict(UA)
    h.update(headers or {})
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=h, method=method)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                raise
            last = e
        except Exception as e:  # network hiccup
            last = e
        time.sleep(2 * (attempt + 1))
    raise last


def exists(url):
    try:
        http(url, method="HEAD", retries=1, timeout=30)
        return True
    except Exception:
        return False


# ----------------------------------------------------------------- GFS
def find_latest_run(max_hour):
    now = dt.datetime.now(dt.timezone.utc)
    base = now.replace(minute=0, second=0, microsecond=0, hour=(now.hour // 6) * 6)
    for back in range(0, 6):
        run = base - dt.timedelta(hours=6 * back)
        d, h = run.strftime("%Y%m%d"), run.strftime("%H")
        url = f"{AWS}/gfs.{d}/{h}/atmos/gfs.t{h}z.pgrb2.1p00.f{max_hour:03d}.idx"
        if exists(url):
            return run
        log(f"  run {d} {h}z not complete yet")
    raise RuntimeError("No complete GFS run found in the last 36 hours")


def fetch_aws(run, fh):
    d, h = run.strftime("%Y%m%d"), run.strftime("%H")
    base = f"{AWS}/gfs.{d}/{h}/atmos/gfs.t{h}z.pgrb2.1p00.f{fh:03d}"
    lines = http(base + ".idx").decode().strip().splitlines()
    starts = [int(l.split(":")[1]) for l in lines]
    parts = []
    for i, l in enumerate(lines):
        key = ":".join(l.split(":")[3:5])
        if key in IDX_KEYS:
            end = starts[i + 1] - 1 if i + 1 < len(lines) else ""
            parts.append(http(base, headers={"Range": f"bytes={starts[i]}-{end}"}))
    if len(parts) != 3:
        raise RuntimeError(f"expected 3 fields in idx, found {len(parts)}")
    return b"".join(parts)


def fetch_nomads(run, fh):
    d, h = run.strftime("%Y%m%d"), run.strftime("%H")
    url = (f"{NOMADS}?dir=%2Fgfs.{d}%2F{h}%2Fatmos&file=gfs.t{h}z.pgrb2.1p00.f{fh:03d}"
           "&var_TMP=on&var_UGRD=on&var_VGRD=on&lev_2_m_above_ground=on&lev_10_m_above_ground=on")
    return http(url, timeout=120)


def decode(blob):
    fields = {}
    for m in decode_messages(blob):
        key = WANTED.get((m["category"], m["parameter"], m["level"]))
        if key:
            if m["scan"] != 0 or abs(m["lat1"] - 90) > 1e-6 or abs(m["lon1"]) > 1e-6:
                raise RuntimeError("unexpected grid orientation")
            fields[key] = m["values"].astype(np.float32)
    if set(fields) != {"t2m", "u10", "v10"}:
        raise RuntimeError(f"missing fields: got {sorted(fields)}")
    return fields


def build_gfs(hours, step, staging):
    run = find_latest_run(hours)
    log(f"GFS run: {run:%Y-%m-%d %H}z")
    steps = []
    for fh in range(0, hours + 1, step):
        try:
            blob = fetch_aws(run, fh)
            src = "aws"
        except Exception as e:
            log(f"  f{fh:03d} AWS failed ({e}); trying NOMADS")
            blob = fetch_nomads(run, fh)
            src = "nomads"
        f = decode(blob)
        steps.append((fh, f))
        log(f"  f{fh:03d} ok via {src}  T {f['t2m'].min()-273.15:.1f}..{f['t2m'].max()-273.15:.1f} C")

    tmin = math.floor(min(float(f["t2m"].min()) for _, f in steps) - 273.15)
    tmax = math.ceil(max(float(f["t2m"].max()) for _, f in steps) - 273.15)
    wmax = math.ceil(max(max(abs(float(f["u10"].min())), abs(float(f["u10"].max())),
                             abs(float(f["v10"].min())), abs(float(f["v10"].max()))) for _, f in steps))

    def q(a, lo, hi):
        return np.clip(np.rint((a - lo) / (hi - lo) * 255.0), 0, 255).astype(np.uint8)

    out_steps = []
    for fh, f in steps:
        rgb = np.dstack([q(f["t2m"] - 273.15, tmin, tmax), q(f["u10"], -wmax, wmax), q(f["v10"], -wmax, wmax)])
        name = f"gfs_f{fh:03d}.png"
        Image.fromarray(rgb, "RGB").save(os.path.join(staging, name), optimize=True)
        valid = run + dt.timedelta(hours=fh)
        out_steps.append({"hour": fh, "valid": valid.strftime("%Y-%m-%dT%H:%MZ"), "file": name})

    ny, nx = steps[0][1]["t2m"].shape
    return {
        "status": "ok",
        "model": "NOAA GFS 1.0°",
        "run": run.strftime("%Y-%m-%dT%H:%MZ"),
        "grid": {"nx": nx, "ny": ny, "lat0": 90, "lon0": 0, "dlat": -1, "dlon": 1},
        "encoding": {
            "r": {"var": "t2m", "unit": "°C", "min": tmin, "max": tmax},
            "g": {"var": "u10", "unit": "m/s", "min": -wmax, "max": wmax},
            "b": {"var": "v10", "unit": "m/s", "min": -wmax, "max": wmax},
        },
        "steps": out_steps,
    }


# ----------------------------------------------------------------- Cyclones
def saffir_simpson(kmh):
    if kmh is None:
        return None
    if kmh < 63:
        return "TD"
    if kmh < 119:
        return "TS"
    for cat, lim in ((1, 154), (2, 178), (3, 209), (4, 252)):
        if kmh < lim:
            return f"Cat {cat}"
    return "Cat 5"


def parse_dt(s):
    if not s:
        return None
    s = s.replace("Z", "")
    try:
        return dt.datetime.fromisoformat(s).replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return None


def ring_center(coords):
    ring = coords[0]
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return [round(sum(xs) / len(xs), 3), round(sum(ys) / len(ys), 3)]


def label_time(label, ref):
    """GDACS labels look like '03/11 06:00 UTC' (day/month, no year)."""
    try:
        dd, mm = label[:5].split("/")
        hh, mi = label[6:11].split(":")
        t = dt.datetime(ref.year, int(mm), int(dd), int(hh), int(mi), tzinfo=dt.timezone.utc)
        if (t - ref).days > 200:
            t = t.replace(year=ref.year - 1)
        elif (ref - t).days > 200:
            t = t.replace(year=ref.year + 1)
        return t
    except Exception:
        return None


def build_cyclones():
    now = dt.datetime.now(dt.timezone.utc)
    events = json.loads(http(GDACS_LIST))
    features = []
    for ev in events.get("features", []):
        p = ev["properties"]
        to = parse_dt(p.get("todate"))
        active = str(p.get("iscurrent")).lower() == "true"
        if not active and (to is None or (now - to).days > RECENT_DAYS):
            continue
        sev = p.get("severitydata") or {}
        peak = sev.get("severity")
        storm_id = f"{p['eventid']}-{p['episodeid']}"
        track = []
        try:
            geo = json.loads(http(p["url"]["geometry"]))
            seg_label = {}
            for g in geo.get("features", []):
                gp = g["properties"]
                if g["geometry"]["type"] == "LineString" and str(gp.get("Class", "")).startswith("Line_"):
                    end = tuple(round(c, 2) for c in g["geometry"]["coordinates"][-1])
                    seg_label[end] = (gp.get("polygonlabel"), bool(gp.get("forecast")))
            pts = []
            for g in geo.get("features", []):
                cls = str(g["properties"].get("Class", ""))
                if cls.startswith("Point_Polygon_Point_"):
                    n = int(cls.rsplit("_", 1)[1])
                    c = ring_center(g["geometry"]["coordinates"])
                    t = label_time(g["properties"].get("polygonlabel", ""), to or now)
                    pts.append((n, c, t))
            pts.sort()
            for n, c, t in pts:
                lab, fc = seg_label.get(tuple(round(v, 2) for v in c), (None, None))
                if fc is None:
                    fc = bool(t and to and t > to)
                track.append({"lon": c[0], "lat": c[1], "time": t.strftime("%Y-%m-%dT%H:%MZ") if t else None,
                              "status": lab, "forecast": fc})
        except Exception as e:
            log(f"  track for {p.get('eventname')} unavailable: {e}")
        observed = [t for t in track if not t["forecast"]]
        current_status = observed[-1]["status"] if observed and observed[-1]["status"] else None
        lon, lat = ev["geometry"]["coordinates"][:2]
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "id": storm_id,
                "name": p.get("eventname"),
                "active": active,
                "status": current_status,
                "peakWindKmh": round(peak) if isinstance(peak, (int, float)) else None,
                "category": saffir_simpson(peak if isinstance(peak, (int, float)) else None),
                "alert": p.get("alertlevel"),
                "from": p.get("fromdate"),
                "to": p.get("todate"),
                "countries": p.get("country"),
                "source": p.get("source"),
                "report": p["url"].get("report"),
                "track": track,
            },
        })
        log(f"  {'ACTIVE' if active else 'ended '} {p.get('eventname')}  peak {peak} km/h  {len(track)} track points")
    features.sort(key=lambda f: (not f["properties"]["active"], -(f["properties"]["peakWindKmh"] or 0)))
    return {"type": "FeatureCollection", "features": features}


# ----------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=72)
    ap.add_argument("--step", type=int, default=6)
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    meta_path = os.path.join(OUT, "meta.json")
    old = {}
    if os.path.exists(meta_path):
        try:
            old = json.load(open(meta_path, encoding="utf8"))
        except Exception:
            old = {}
    now = dt.datetime.now(dt.timezone.utc)
    meta = {"generated": now.strftime("%Y-%m-%dT%H:%MZ")}
    failures = 0

    staging = os.path.join(OUT, "_staging")
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging)
    log("== GFS temperature and wind")
    try:
        gfs = build_gfs(args.hours, args.step, staging)
        for f in os.listdir(OUT):
            if f.startswith("gfs_f") and f.endswith(".png"):
                os.remove(os.path.join(OUT, f))
        for f in os.listdir(staging):
            shutil.move(os.path.join(staging, f), os.path.join(OUT, f))
        meta["gfs"] = gfs
    except Exception as e:
        failures += 1
        log(f"GFS FAILED: {e}")
        prev = old.get("gfs") if old.get("gfs", {}).get("steps") else None
        if prev:
            prev = dict(prev)
            prev["status"] = "stale"
            prev["message"] = f"Latest update failed ({e}); showing previous run."
            meta["gfs"] = prev
        else:
            meta["gfs"] = {"status": "error", "message": f"Could not download GFS data: {e}", "steps": []}
    shutil.rmtree(staging, ignore_errors=True)

    log("== GDACS tropical cyclones")
    try:
        cyc = build_cyclones()
        with open(os.path.join(OUT, "cyclones.geojson"), "w", encoding="utf8") as fh:
            json.dump(cyc, fh, separators=(",", ":"))
        n_active = sum(1 for f in cyc["features"] if f["properties"]["active"])
        meta["cyclones"] = {"status": "ok", "file": "cyclones.geojson", "active": n_active,
                            "recent": len(cyc["features"]) - n_active, "recentDays": RECENT_DAYS,
                            "updated": now.strftime("%Y-%m-%dT%H:%MZ")}
    except Exception as e:
        failures += 1
        log(f"CYCLONES FAILED: {e}")
        meta["cyclones"] = {"status": "error", "message": f"Could not download cyclone data from GDACS: {e}"}

    with open(meta_path, "w", encoding="utf8") as fh:
        json.dump(meta, fh, indent=1, ensure_ascii=False)
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    log(f"== done: {len(os.listdir(OUT))} files, {total/1024:.0f} KB, {failures} source(s) failed")
    # exit non-zero only if everything failed, so the site still deploys with partial data
    return 1 if failures == 2 else 0


if __name__ == "__main__":
    sys.exit(main())
