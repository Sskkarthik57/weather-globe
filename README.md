# Atmos Globe: a free, interactive 3D weather globe

A spinning 3D Earth in your browser. It shows:

- **Temperature**: a coloured map of air temperature 2 m above the ground.
- **Air quality**: a pollution map showing the US Air Quality Index (AQI), Good to Hazardous. Clicking a place shows its AQI score, PM2.5, PM10, ozone and more.
- **Wind**: glowing streaks that flow with the wind 10 m above the ground.
- **Cyclones**: active tropical storms worldwide, with past and forecast tracks.
- **Rivers**: about 1,400 major rivers on every continent, with pulses that flow downstream. Click a river (or search for it, e.g. "Ganga") to see where it starts (the mountain, glacier or lake), where it drains, its tributaries and the dams on it, all marked on the globe.

You can drag the **time slider** (or press play) to move through the next 3 days in 3-hour steps. **Click anywhere** for the local forecast, use the **⌖ button** for your own location, or **search**: cities, towns, villages, suburbs, landmarks, airports, peaks, or coordinates like `17.38, 78.48`. When you're zoomed in, places near the area on screen come first.

Everything is free. There are no accounts and no API keys.

| What | Where it comes from |
|---|---|
| Temperature and wind maps | NOAA GFS weather model at 0.25° (about 28 km; wind shown at 0.5°), every 3 hours (US government, public domain), downloaded by our own script |
| Air-quality map | NOAA GEFS-Aerosols model at 0.25°: surface PM2.5 and PM10 (public domain), turned into US AQI by our script, with natural sea-salt spray left out |
| Air quality when you click | Open-Meteo Air Quality API (CAMS, Copernicus) |
| Cyclones | GDACS (European Commission and United Nations) |
| Local forecast | Open-Meteo.com (free for non-commercial use, CC BY 4.0) |
| Place search | Photon by komoot (OpenStreetMap data, ODbL; free, no key, fair use) plus Open-Meteo geocoding (GeoNames, CC BY 4.0) |
| Place names when you click | Nominatim / OpenStreetMap |
| Earth pictures | NASA Blue Marble (day: 8k ≈ 4.9 km per pixel on fast PCs, 4k/2k otherwise) and Black Marble (night lights) |
| River lines | Natural Earth 1:10m rivers (public domain) |
| River source, mouth, tributaries, dams | Wikidata (CC0), collected by our own script |
| River photo and summary | Wikipedia (CC BY-SA), loaded when you click a river |

---

## 1. One-time setup on your PC

This is already done on this PC. A portable copy of **Node.js** is in the `.tools` folder, so nothing was installed system-wide. Python 3 was already installed.

**Every time you open a new terminal** (**Terminal → New Terminal** in VS Code), paste this line first so the terminal can find the project's Node.js:

```powershell
$env:Path = "$PWD\.tools\node-v26.13.1-win-x64;" + $env:Path
```

(If you'd rather install Node.js normally from https://nodejs.org, you can skip that line.)

Setting up a fresh copy of the project on another PC:

```powershell
npm.cmd install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r scripts\requirements.txt
```

The Earth pictures are already in `public\textures`. If you ever need to download them again:

```powershell
.\.venv\Scripts\python.exe scripts\prepare_textures.py
```

## 2. Get fresh weather data

This takes 2–3 minutes. It downloads only the fields it needs from NOAA (roughly 100–200 MB, several files at a time):

```powershell
.\.venv\Scripts\python.exe scripts\update_data.py
```

It writes compact `.bin` files into `public\data` (about 34 MB in total for 25 three-hourly steps: temperature ≈ 445 KB, wind ≈ 275 KB and air quality ≈ 620 KB per step). The values are exact to 0.1 °C and 0.2 m/s, and they don't go through image decoding, so every browser shows the same numbers. Visitors don't download all of it: a PC loads temperature and wind in the background (about 18 MB), a phone only the hours around the one being viewed, and air quality loads only when that layer is switched on.

**Why the map and the click panel can still differ a little:** the map is NOAA's global model (one value per ~28 km square, shown at the slider time), while the panel asks Open-Meteo for its best local model (1–11 km) for *right now*. The panel prints the map's own value too ("Globe map … here"), and the hover readout always matches the map colours exactly. For air quality, the panel's CAMS score also counts ozone and NO₂, which the map (PM2.5 and PM10 only) does not.

**How fresh is the data?**

- NOAA releases a new weather run (and air-quality run) every 6 hours, about 4–5 hours after 00, 06, 12 and 18 UTC. That's the fastest any free global model updates.
- The online site checks every hour and republishes as soon as a new run appears, so it's never more than about an hour behind NOAA. Cyclones and air quality are refreshed at least every 3 hours.
- The click panel (local forecast and AQI) is always live: it asks Open-Meteo at the moment you click.

**River data** is separate and rarely changes, so it's stored in git (`public\rivers`) and doesn't need the robot. To rebuild it (about 10 minutes, mostly waiting on Wikidata), run:

```powershell
.\.venv\Scripts\python.exe scripts\build_rivers.py
```

## 3. Run it on your PC

```powershell
npm.cmd run dev
```

Then open http://localhost:5173 in your browser. Press **Ctrl + C** in the terminal to stop it.

To test the finished, optimised version instead:

```powershell
npm.cmd run build
npm.cmd run preview
```

Then open http://localhost:4173.

Automated browser test: run it while `npm.cmd run preview` is running, in a second terminal. Screenshots go to the `screenshots` folder.

```powershell
node scripts\check.mjs
```

## 4. Put it on the internet for free (GitHub Pages)

**Already done.** The site is live at **https://sskkarthik57.github.io/weather-globe/**. The code is at https://github.com/Sskkarthik57/weather-globe. A GitHub robot checks for new data every hour, free because GitHub Actions is unlimited for public repositories.

To publish changes later, paste this in a terminal in the project folder (portable Git and the GitHub tool are in `.tools`):

```powershell
$env:Path = "$PWD\.tools\gh\bin;$PWD\.tools\git\cmd;$PWD\.tools\node-v26.13.1-win-x64;" + $env:Path
git add -A
git commit -m "Describe your change"
git push
```

To refresh the data right now without waiting: GitHub → your repository → **Actions** → **Update data and deploy** → **Run workflow**.

Starting from scratch on a new account instead? Do this once. After that, a robot on GitHub refreshes the data every 6 hours and republishes the site.

1. Create a free account at https://github.com.
2. Create a new **empty** repository (for example `weather-globe`). Don't add a README there.
3. Install Git: https://git-scm.com/download/win (accept the defaults), then close and reopen VS Code.
4. Paste this, replacing `YOUR-NAME` and `YOUR-REPO`:

```powershell
git init
git add .
git commit -m "Weather globe"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/YOUR-REPO.git
git push -u origin main
```

5. On GitHub, open your repository, then **Settings → Pages → Build and deployment → Source: GitHub Actions**.
6. Open the **Actions** tab, choose **Update data and deploy**, then **Run workflow**.
7. When it turns green (about 3 minutes), your site is at `https://YOUR-NAME.github.io/YOUR-REPO/`.

Good to know:

- GitHub pauses scheduled robots on repositories with no activity for 60 days. If the data stops updating, go to the **Actions** tab and re-enable the workflow, or click **Run workflow**.
- The free Open-Meteo service is for **non-commercial** use, up to 10,000 requests per day. Each visitor click uses 1 request.

## Using the globe

| Action | Mouse / keyboard | Touch |
|---|---|---|
| Rotate | drag, or arrow keys | drag with one finger |
| Zoom | scroll wheel, or + / − | pinch |
| Local weather | click | tap |
| Play / pause the forecast | Space, or ▶ button | ▶ button |
| Show frame rate and quality | **Shift + F** or ⚙ Settings | ⚙ Settings |

Settings (⚙) also has a quality override (Auto / Low / Med / High), °C or °F, and auto-rotate on or off.

## What's in the folder

```
index.html, src/          the website (three.js and custom GPU shaders)
public/textures/          NASA Earth pictures (resized)
public/data/              weather data made by the script (not stored in git)
scripts/update_data.py    downloads GFS, GEFS-Aerosols + cyclones, writes .bin grids + JSON
src/decode.worker.js      unpacks the .bin grids in the background (keeps the globe smooth)
scripts/grib2.py          small built-in reader for NOAA's GRIB2 weather format
scripts/build_rivers.py   Natural Earth rivers + Wikidata facts -> public/rivers (run rarely)
scripts/prepare_textures.py   one-time download of the NASA pictures
scripts/check*.mjs        automated browser tests (screenshots in /screenshots)
.tools/                   portable Node.js (not stored in git)
.github/workflows/        the 6-hourly update and publish robot
```

Why the custom GRIB reader: the standard GRIB library (eccodes) is blocked by Windows "Smart App Control" on this PC. The built-in reader needs only NumPy, and its output was checked against Open-Meteo's GFS values.
