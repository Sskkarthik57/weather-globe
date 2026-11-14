"""One-time download + resize of the Earth textures (NASA, public domain).

  Blue Marble Next Generation (November 2004), NASA Earth Observatory / Reto Stockli
  Black Marble 2016 city lights, NASA Earth Observatory / NOAA NGDC (Suomi NPP VIIRS)

Writes public/textures/{day,night}_{4k,2k}.jpg and water_2k.png (ocean mask for sun glint).
Usage: python scripts/prepare_textures.py
"""
import io
import os
import urllib.request

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "textures")
UA = {"User-Agent": "weather-globe-texture-prep/1.0"}
DAY = "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/november/world.200411.3x5400x2700.jpg"
NIGHT = "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg"


def fetch(url):
    print("downloading", url, flush=True)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
        return Image.open(io.BytesIO(r.read())).convert("RGB")


def main():
    os.makedirs(OUT, exist_ok=True)
    day = fetch(DAY)
    night = fetch(NIGHT)
    for name, im in (("day", day), ("night", night)):
        for tag, w in (("4k", 4096), ("2k", 2048)):
            im.resize((w, w // 2), Image.LANCZOS).save(os.path.join(OUT, f"{name}_{tag}.jpg"), quality=86, optimize=True, progressive=True)
    # ocean mask: Blue Marble oceans are dark and strongly blue
    a = np.asarray(day.resize((2048, 1024), Image.LANCZOS)).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    water = (b > r * 1.25) & (b > g * 0.95) & ((r + g + b) / 3 < 95)
    m = Image.fromarray((water * 255).astype(np.uint8), "L").filter(__import__("PIL.ImageFilter", fromlist=["x"]).GaussianBlur(1.2))
    m.save(os.path.join(OUT, "water_2k.png"), optimize=True)
    for f in sorted(os.listdir(OUT)):
        print(f"  {f}: {os.path.getsize(os.path.join(OUT, f))/1024:.0f} KB")


if __name__ == "__main__":
    main()
