"""Appends the BrokenFront columns to the render atlases.

    python scripts/brokenfront_atlases.py

The atlases (resources/atlases/) have no generator in this repo, so this
script extends the committed PNGs in place: it keeps the stock columns
byte-for-byte and adds one column per new type, in the order StructurePass
(STRUCTURE_ORDER) and UnitPass (UNIT_ORDER) list them. Run it once on the
stock atlases; it refuses to run on atlases that already have the columns.

Needs Pillow. Structure icons are white alpha masks (64x64); unit sprites
use the unit atlas' palette (13x13), which the shader recolors per owner.
"""

import math
import pathlib
import sys

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICON_ATLAS = ROOT / "resources/atlases/icon-atlas.png"
UNIT_ATLAS = ROOT / "resources/atlases/unit-atlas.png"

STOCK_ICON_COLS = 6
STOCK_UNIT_COLS = 12
ICON = 64
UNIT = 13

# Unit atlas palette (see the stock sprites).
LIGHT = (180, 180, 180, 255)
MID = (130, 130, 130, 255)
DARK = (100, 100, 100, 255)
DARKER = (70, 70, 70, 255)
RED = (237, 28, 36, 255)
WHITE = (255, 255, 255, 255)


def icon(draw_fn) -> Image.Image:
    """Draws at 4x and downsamples for smooth edges."""
    big = Image.new("RGBA", (ICON * 4, ICON * 4), (0, 0, 0, 0))
    draw_fn(ImageDraw.Draw(big), ICON * 4)
    return big.resize((ICON, ICON), Image.LANCZOS)


def uranium_mine(d: ImageDraw.ImageDraw, s: int) -> None:
    # Radiation trefoil.
    c = s / 2
    r_out, r_in = s * 0.42, s * 0.12
    for k in range(3):
        a0 = math.radians(-90 + k * 120 - 30)
        a1 = math.radians(-90 + k * 120 + 30)
        pts = [(c + r_in * math.cos(a0), c + r_in * math.sin(a0))]
        for i in range(13):
            a = a0 + (a1 - a0) * i / 12
            pts.append((c + r_out * math.cos(a), c + r_out * math.sin(a)))
        pts.append((c + r_in * math.cos(a1), c + r_in * math.sin(a1)))
        d.polygon(pts, fill=(255, 255, 255, 255))
    d.ellipse([c - s * 0.08, c - s * 0.08, c + s * 0.08, c + s * 0.08], fill=WHITE)


def oil_rig(d: ImageDraw.ImageDraw, s: int) -> None:
    w = s * 0.06
    top, base = s * 0.12, s * 0.68
    d.line([(s * 0.5, top), (s * 0.3, base)], fill=WHITE, width=int(w))
    d.line([(s * 0.5, top), (s * 0.7, base)], fill=WHITE, width=int(w))
    d.line([(s * 0.36, s * 0.48), (s * 0.64, s * 0.48)], fill=WHITE, width=int(w))
    d.rectangle([s * 0.18, base, s * 0.82, base + s * 0.08], fill=WHITE)
    d.rectangle([s * 0.24, base + s * 0.08, s * 0.3, s * 0.88], fill=WHITE)
    d.rectangle([s * 0.7, base + s * 0.08, s * 0.76, s * 0.88], fill=WHITE)


def airbase(d: ImageDraw.ImageDraw, s: int) -> None:
    # Plane seen from above.
    c = s / 2
    d.polygon(
        [
            (c, s * 0.1),
            (c + s * 0.06, s * 0.36),
            (s * 0.9, s * 0.56),
            (s * 0.9, s * 0.64),
            (c + s * 0.06, s * 0.54),
            (c + s * 0.05, s * 0.76),
            (c + s * 0.18, s * 0.86),
            (c + s * 0.18, s * 0.9),
            (c, s * 0.85),
            (c - s * 0.18, s * 0.9),
            (c - s * 0.18, s * 0.86),
            (c - s * 0.05, s * 0.76),
            (c - s * 0.06, s * 0.54),
            (s * 0.1, s * 0.64),
            (s * 0.1, s * 0.56),
            (c - s * 0.06, s * 0.36),
        ],
        fill=WHITE,
    )


def sprite(pattern: list[str], palette: dict[str, tuple]) -> Image.Image:
    img = Image.new("RGBA", (UNIT, UNIT), (0, 0, 0, 0))
    for y, row in enumerate(pattern):
        for x, ch in enumerate(row):
            if ch in palette:
                img.putpixel((x, y), palette[ch])
    return img


PAL = {"l": LIGHT, "o": MID, "d": DARK, "x": DARKER, "R": RED, "W": WHITE}

LARGE_NUKE = [
    ".............",
    ".............",
    "......o......",
    ".....ooo.....",
    "....ollll....",
    "...olllllo...",
    "..oollRlloo..",
    "...olllllo...",
    "....ollll....",
    ".....ooo.....",
    "......o......",
    ".............",
    ".............",
]
CLUSTER_NUKE = [
    ".............",
    "......o......",
    ".....oRo.....",
    "......o......",
    "..o..ooo..o..",
    ".oRo.olo.oRo.",
    "..o.ollo..o..",
    "......o......",
    "......o......",
    ".....oRo.....",
    "......o......",
    ".............",
    ".............",
]
CLUSTER_WARHEAD = [
    ".............",
    ".............",
    ".............",
    ".............",
    ".....WWW.....",
    "....WWRWW....",
    "....WRRRW....",
    "....WWRWW....",
    ".....WWW.....",
    ".............",
    ".............",
    ".............",
    ".............",
]
FISHING_BOAT = [
    ".............",
    ".............",
    ".............",
    ".............",
    ".............",
    "......l......",
    ".....lxl.....",
    "......l......",
    ".............",
    ".............",
    ".............",
    ".............",
    ".............",
]
CARRIER = [
    ".............",
    ".............",
    ".............",
    "..lllllllll..",
    ".lxxxxxxxxxl.",
    ".lxdddddddxl.",
    ".lxxxxxxxxxl.",
    ".lxxxxxxxddl.",
    "..lllllllll..",
    ".............",
    ".............",
    ".............",
    ".............",
]
FIGHTER = [
    ".............",
    ".............",
    ".............",
    "......l......",
    "......l......",
    "....lllll....",
    "...lllllll...",
    "......l......",
    ".....lll.....",
    ".............",
    ".............",
    ".............",
    ".............",
]
BOMBER = [
    ".............",
    ".............",
    "......o......",
    "......o......",
    "......o......",
    ".ooooooooooo.",
    ".ooooooooooo.",
    "......o......",
    "......o......",
    "....ooooo....",
    ".............",
    ".............",
    ".............",
]
TRANSPORT_PLANE = [
    ".............",
    ".............",
    "......l......",
    ".....lll.....",
    ".....lll.....",
    "..lllllllll..",
    ".....lll.....",
    ".....lll.....",
    "....lllll....",
    ".............",
    ".............",
    ".............",
    ".............",
]
TROOP_COLUMN = [
    ".............",
    ".............",
    ".............",
    ".............",
    "....lllll....",
    "....lxxxl....",
    "....lxxxl....",
    "....lxxxl....",
    "....lllll....",
    ".............",
    ".............",
    ".............",
    ".............",
]

# Must match the order appended to STRUCTURE_ORDER / UNIT_ORDER.
NEW_ICONS = [uranium_mine, oil_rig, airbase]
NEW_UNITS = [
    LARGE_NUKE,
    CLUSTER_NUKE,
    CLUSTER_WARHEAD,
    FISHING_BOAT,
    CARRIER,
    FIGHTER,
    BOMBER,
    TRANSPORT_PLANE,
    TROOP_COLUMN,
]


def extend(path: pathlib.Path, stock_cols: int, size: int, cols: list) -> None:
    atlas = Image.open(path).convert("RGBA")
    if atlas.size != (stock_cols * size, size):
        sys.exit(f"{path.name}: expected the stock {stock_cols} columns, got {atlas.size}")
    out = Image.new("RGBA", ((stock_cols + len(cols)) * size, size), (0, 0, 0, 0))
    out.paste(atlas, (0, 0))
    for i, col in enumerate(cols):
        out.paste(col, ((stock_cols + i) * size, 0))
    out.save(path, optimize=True)
    print(f"{path.name}: {stock_cols} -> {stock_cols + len(cols)} columns")


def main() -> None:
    extend(ICON_ATLAS, STOCK_ICON_COLS, ICON, [icon(f) for f in NEW_ICONS])
    extend(UNIT_ATLAS, STOCK_UNIT_COLS, UNIT, [sprite(p, PAL) for p in NEW_UNITS])


if __name__ == "__main__":
    main()
