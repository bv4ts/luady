"""Draws the link-preview picture, site/public/brand/social-card.png (1280 x 640): the logo and the name over the
office at night. Every piece is the project's own art at a whole-number scale: the logo's 48 px master (read back from
.github/assets/logo-512.png, which is that master at 10x), the office still from site/public/pixel/, and the name in
Pixelify Sans (site/fonts/pixelify-sans/).

    python site/scripts/make-social-card.py

Run it from the repository root after the logo or the pixel art changes. Needs Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "public" / "brand" / "social-card.png"
W, H = 1280, 640
NAVY = (12, 19, 40)
CREAM = (255, 244, 220)
DIM = (198, 191, 216)
TEAL_DEEP = (21, 92, 84)

card = Image.new("RGB", (W, H), NAVY)
draw = ImageDraw.Draw(card)

# Pixel stars in the top part of the sky, at fixed places.
for i in range(46):
    x = (i * 277 + 53) % W
    y = (i * 131 + 17) % 280
    size = 3 if i % 5 == 0 else 2
    draw.rectangle([x, y, x + size - 1, y + size - 1], fill=(233, 231, 255) if i % 3 else (255, 233, 163))

# The office: part of the toy's first view (Cedar's desks and HQ) at 2x, along the bottom, its top edge stepping
# into the night sky.
still = Image.open(ROOT / "site" / "public" / "pixel" / "office-still.png").convert("RGB")
band = still.crop((516, 34, 516 + 640, 34 + 170)).resize((1280, 340), Image.NEAREST)
card.paste(band, (0, H - 340))
for step in range(6):
    shade = Image.new("RGBA", (W, 8), NAVY + (int(255 * (1 - step / 6)),))
    card.paste(shade, (0, H - 340 + step * 8), shade)

# The logo: the 48 px master, recovered exactly from the 10x file, drawn at 4x.
big = Image.open(ROOT / ".github" / "assets" / "logo-512.png").convert("RGBA")
master = big.crop((16, 16, 496, 496)).resize((48, 48), Image.NEAREST)
logo = master.resize((192, 192), Image.NEAREST)
card.paste(logo, (64, 52), logo)

font_path = ROOT / "site" / "fonts" / "pixelify-sans" / "PixelifySans.ttf"
name = ImageFont.truetype(str(font_path), 112)
name.set_variation_by_axes([700])
line = ImageFont.truetype(str(font_path), 42)
line.set_variation_by_axes([600])
draw.text((292 + 6, 58 + 6), "Luady", font=name, fill=TEAL_DEEP)
draw.text((292, 58), "Luady", font=name, fill=CREAM)
draw.text((296, 196), "A pixel-art office for your", font=line, fill=CREAM)
draw.text((296, 244), "Claude Code sessions", font=line, fill=DIM)

OUT.parent.mkdir(parents=True, exist_ok=True)
card.save(OUT, optimize=True)
print(f"{OUT} {card.size}")
