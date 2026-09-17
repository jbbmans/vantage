"""Rasterize the approved SVG; no redraw or brand substitutions.

Requires CairoSVG and Pillow. Run from the repository root.
"""
from pathlib import Path
from io import BytesIO
import cairosvg
from PIL import Image

root = Path(__file__).resolve().parents[1] / 'public'
svg = (root / 'vantage-favicon.svg').read_bytes()
for name, size in [('favicon-16.png', 16), ('favicon-32.png', 32),
                   ('icon-192.png', 192), ('icon-512.png', 512),
                   ('apple-touch-icon.png', 180)]:
    cairosvg.svg2png(bytestring=svg, output_width=size, output_height=size,
                    write_to=str(root / name))
icon = Image.open(BytesIO(cairosvg.svg2png(bytestring=svg, output_width=256,
                                         output_height=256))).convert('RGBA')
icon.save(root / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
# The maskable symbol fits within the centered 80% safe zone.
maskable = Image.new('RGBA', (512, 512), '#0B2D5B')
mark = Image.open(BytesIO(cairosvg.svg2png(
    url=str(root / 'brand/mark-reversed.svg'), output_width=330,
    output_height=330))).convert('RGBA')
maskable.alpha_composite(mark, (91, 91))
maskable.save(root / 'icon-maskable-512.png')
