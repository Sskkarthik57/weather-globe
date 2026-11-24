"""One-time download + resize of the Earth textures (NASA, public domain).

  Blue Marble Next Generation (November 2004), NASA Earth Observatory / Reto Stockli
    source: 21600 x 10800 (about 1.9 km per pixel)
  Black Marble 2016 city lights, NASA Earth Observatory / NOAA NGDC (Suomi NPP VIIRS)
    source: 13500 x 6750 (3 km per pixel)

Writes public/textures/:
  day_8k.jpg   8192 x 4096 (about 4.9 km per pixel; loaded only on the high quality tier on capable GPUs)
  day_4k.jpg, night_4k.jpg   4096 x 2048
  day_2k.jpg, night_2k.jpg   2048 x 1024
  water_2k.png               ocean mask for sun glint
Usage: python scripts/prepare_textures.py
"""
import io
import os
import urllib.request

import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "textures")
UA = {"User-Agent": "weather-globe-texture-prep/1.0"}
DAY = "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/november/world.200411.3x21600x10800.jpg"
NIGHT = "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg"


def fetch(url, min_width):
    print("downloading", url, flush=True)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600) as r:
        im = Image.open(io.BytesIO(r.read()))
    # let the JPEG decoder downscale by a power of two while decoding (saves gigabytes of RAM)
    im.draft("RGB", (min_width, min_width // 2))
    return im.convert("RGB")


def save(im, name, w, quality):
    im.resize((w, w // 2), Image.LANCZOS).save(os.path.join(OUT, name), quality=quality, optimize=True, progressive=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    day = fetch(DAY, 8192)
    print("  day decoded at", day.size, flush=True)
    save(day, "day_8k.jpg", 8192, 84)
    day = day.resize((4096, 2048), Image.LANCZOS)
    save(day, "day_4k.jpg", 4096, 86)
    save(day, "day_2k.jpg", 2048, 86)
    night = fetch(NIGHT, 4096)
    save(night, "night_4k.jpg", 4096, 86)
    save(night, "night_2k.jpg", 2048, 86)
    # ocean mask: Blue Marble oceans are dark and strongly blue
    a = np.asarray(day.resize((2048, 1024), Image.LANCZOS)).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    water = (b > r * 1.25) & (b > g * 0.95) & ((r + g + b) / 3 < 95)
    Image.fromarray((water * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(1.2)) \
        .save(os.path.join(OUT, "water_2k.png"), optimize=True)
    for f in sorted(os.listdir(OUT)):
        print(f"  {f}: {os.path.getsize(os.path.join(OUT, f))/1024:.0f} KB")


if __name__ == "__main__":
    main()
