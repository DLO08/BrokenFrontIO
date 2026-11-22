"""Generates the BrokenFront homepage backdrop.

    python scripts/brokenfront_backdrop.py [out_dir]

Writes two images that index.html stacks inside #hex-grid, both at 30%
opacity (and a sepia filter in dark mode), so the sources are built brighter
and more contrasty than they look on the page:

  background.webp       the static field -- terrain plates, coastlines,
                        contours, the hex lattice with its contested cells,
                        the survey grid, markers and trajectory arcs.
  BackdropFronts.webp   the three front lines and strike heads, on black.
                        The page screen-blends it over the field (black is a
                        no-op under `screen`) and animates it on its own, so
                        the fronts breathe and drift against the terrain.

An abstract tactical field, deliberately not a map of anywhere: territory
plates thresholded out of a ridged noise field, their coastlines and interior
contours, a hex lattice, and three jagged front lines with tick marks. The
centre is damped so the lobby panel stays readable over it.

Output is deterministic for a given SEED -- change it to roll a new field.
Needs numpy and Pillow.
"""

import math
import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "resources/images"
FIELD_NAME = "background.webp"
FRONTS_NAME = "BackdropFronts.webp"

W, H = 2560, 1440
S = 2  # supersample factor for the vector layers
SEED = 20261122
rng = np.random.default_rng(SEED)

# --- palette -----------------------------------------------------------------
BASE_TOP = np.array([11, 10, 10], np.float32)
BASE_BOT = np.array([23, 18, 15], np.float32)
LAND = np.array([72, 63, 55], np.float32)  # plate fill
HIGHLAND = np.array([46, 36, 28], np.float32)  # interior plateau
AMBER_DIM = np.array([176, 108, 54], np.float32)
AMBER = np.array([208, 126, 60], np.float32)
BRAND = np.array([242, 128, 74], np.float32)
HOT = np.array([255, 162, 96], np.float32)  # front-line core
SPARK = np.array([255, 214, 170], np.float32)  # strike heads
HAZE = np.array([98, 94, 92], np.float32)


# --- noise -------------------------------------------------------------------
def smooth(gw, gh, w=W, h=H):
    g = rng.random((gh, gw)).astype(np.float32)
    return np.asarray(
        Image.fromarray(g, mode="F").resize((w, h), Image.BICUBIC), dtype=np.float32
    )


def fbm(octaves, base=3, w=W, h=H):
    out = np.zeros((h, w), np.float32)
    amp, total = 1.0, 0.0
    gw, gh = base, max(2, int(base * h / w))
    for _ in range(octaves):
        out += amp * smooth(gw, gh, w, h)
        total += amp
        amp *= 0.5
        gw, gh = gw * 2, gh * 2
    out /= total
    return norm(out)


def norm(a):
    a = a - a.min()
    return a / max(a.max(), 1e-6)


# --- base gradient ------------------------------------------------------------
yy = np.linspace(0.0, 1.0, H, dtype=np.float32)[:, None]
xx = np.linspace(0.0, 1.0, W, dtype=np.float32)[None, :]
ramp = (yy**1.3) * np.ones((1, W), np.float32)
img = (
    BASE_TOP[None, None, :]
    + (BASE_BOT - BASE_TOP)[None, None, :] * ramp[:, :, None]
).astype(np.float32)

field = fbm(6, base=4)
# Ridge it so the shapes read as broken plates rather than soft blobs.
ridge = norm(1.0 - np.abs(field * 2.0 - 1.0))
field = norm(field * 0.72 + ridge * 0.28)

# Plate outlines come off a smoothed copy, so coastlines stay chunky while
# the contour lines below still follow the fine detail.
_small = Image.fromarray(field, mode="F").resize((W // 5, H // 5), Image.BILINEAR)
plate_field = np.asarray(_small.resize((W, H), Image.BICUBIC), np.float32)
gy, gx = np.gradient(plate_field)
fgrad = np.hypot(gx, gy) + 1e-6  # field units per pixel


def plate(level, edge_px=1.4, line_px=2.4):
    """Hard-edged region above `level`, plus its boundary line.

    Both are antialiased in pixel space (the signed distance to the level set
    is the field offset divided by its gradient), so the edge stays the same
    weight whether the field is steep or flat there.
    """
    sd = (plate_field - level) / fgrad
    fill = np.clip(sd / edge_px + 0.5, 0.0, 1.0)
    edge = np.clip(1.0 - (np.abs(sd) - line_px * 0.5) / 1.2, 0.0, 1.0)
    return fill, edge


# Pick the levels by area, not by value: ~38% of the frame is held territory
# and ~14% of it is interior, whatever the noise happened to produce.
SEA_LEVEL = float(np.quantile(plate_field, 0.62))
HIGH_LEVEL = float(np.quantile(plate_field, 0.86))
land, coast = plate(SEA_LEVEL, line_px=2.6)
high, ridge_edge = plate(HIGH_LEVEL, line_px=1.8)

# Interior shading: a little brighter toward the middle of each plate.
interior = np.clip((plate_field - SEA_LEVEL) / 0.22, 0.0, 1.0)
img += LAND[None, None, :] * (land * (0.70 + 0.45 * interior))[:, :, None]
img += HIGHLAND[None, None, :] * (high * 0.85)[:, :, None]

# --- topographic contour lines, on land only ----------------------------------
LEVELS = 11
t = field * LEVELS
frac = t - np.floor(t)
d = np.minimum(frac, 1.0 - frac)
grad = fgrad * LEVELS
px = d / grad  # distance to the nearest contour, in pixels

major = (np.floor(t).astype(np.int32) % 3) == 0
half = np.where(major, 1.1, 0.6).astype(np.float32)
line = np.clip(1.0 - (px - half) / 1.0, 0.0, 1.0)
line *= np.where(major, 1.0, 0.6).astype(np.float32)
line *= land * (0.35 + 0.65 * interior)

img += AMBER_DIM[None, None, :] * line[:, :, None] * 1.10

# --- plate boundaries ---------------------------------------------------------
img += AMBER[None, None, :] * coast[:, :, None] * 1.40
img += AMBER_DIM[None, None, :] * ridge_edge[:, :, None] * 0.70

# --- sea grid + haze ----------------------------------------------------------
# A faint survey grid, mostly visible over the empty water.
GRID = 72
gridx = np.minimum(np.arange(W) % GRID, GRID - np.arange(W) % GRID) < 1
gridy = np.minimum(np.arange(H) % GRID, GRID - np.arange(H) % GRID) < 1
grid = (gridx[None, :] | gridy[:, None]).astype(np.float32)
img += AMBER_DIM[None, None, :] * (grid * (0.08 + 0.05 * land))[:, :, None]

haze = fbm(4, base=3)
haze = np.clip((haze - 0.5) / 0.5, 0.0, 1.0) ** 1.5
img += HAZE[None, None, :] * haze[:, :, None] * 0.08

# Alias used by the lattice weighting below.
elev = land * (0.35 + 0.65 * interior)


# --- vector layers (hexes, fronts, markers) ----------------------------------
def layer():
    return Image.new("L", (W * S, H * S), 0)


def down(mask, blur=0.0):
    if blur:
        mask = mask.filter(ImageFilter.GaussianBlur(blur * S))
    return (
        np.asarray(mask.resize((W, H), Image.LANCZOS), dtype=np.float32) / 255.0
    ).clip(0.0, 1.0)


def add(mask, color, gain):
    np.add(img, color[None, None, :] * mask[:, :, None] * gain, out=img)


R = 118.0 * S  # hex circumradius
HX = math.sqrt(3.0) * R  # horizontal spacing (pointy-top)
HY = 1.5 * R  # vertical spacing


def hex_center(col, row):
    return (col * HX + (HX / 2 if row % 2 else 0) - HX, row * HY - R)


def hex_pts(cx, cy, r=R):
    return [
        (
            cx + r * math.sin(math.radians(60 * i)),
            cy - r * math.cos(math.radians(60 * i)),
        )
        for i in range(6)
    ]


COLS = int(W * S / HX) + 3
ROWS = int(H * S / HY) + 3

# Lattice.
lat = layer()
dl = ImageDraw.Draw(lat)
for row in range(ROWS):
    for col in range(COLS):
        cx, cy = hex_center(col, row)
        dl.polygon(hex_pts(cx, cy), outline=255, width=max(1, int(1.6 * S)))
lattice = down(lat, blur=0.3)

# A broken cluster of lit cells, grown from a few seeds near the edges of the
# frame so the middle (where the lobby panel sits) stays quiet.
seeds = [
    (3, 4),
    (4, 12),
    (COLS - 5, 3),
    (COLS - 4, 10),
    (COLS - 7, ROWS - 3),
    (2, ROWS - 4),
]
lit = set()
for sc, sr in seeds:
    c, r = sc, sr
    for _ in range(int(rng.integers(3, 6))):
        if 0 <= c < COLS and 0 <= r < ROWS:
            lit.add((c, r))
        c += int(rng.integers(-1, 2))
        r += int(rng.integers(-1, 2))

fill_l, edge_l = layer(), layer()
df, de = ImageDraw.Draw(fill_l), ImageDraw.Draw(edge_l)
for c, r in lit:
    cx, cy = hex_center(c, r)
    pts = hex_pts(cx, cy, R * 0.97)
    df.polygon(pts, fill=30)
    de.polygon(pts, outline=255, width=max(1, int(2.2 * S)))
lit_fill = down(fill_l)
lit_edge = down(edge_l, blur=0.4)
lit_glow = down(edge_l, blur=7.0)


# --- front lines --------------------------------------------------------------
def front_path(y0, y1, amp, octs=5):
    """A jagged left-to-right path, displaced by layered sine noise."""
    phases = rng.random(octs) * math.tau
    freqs = [1.1, 2.3, 4.7, 9.1, 17.0][:octs]
    amps = [1.0, 0.52, 0.27, 0.14, 0.08][:octs]
    pts = []
    n = 440
    for i in range(n + 1):
        u = i / n
        off = sum(
            a * math.sin(u * math.tau * f + p) for a, f, p in zip(amps, freqs, phases)
        )
        off /= sum(amps)
        pts.append((u * W * S, (y0 + (y1 - y0) * u + off * amp) * S))
    return pts


fronts = [
    (front_path(380, 250, 120), 1.00),
    (front_path(840, 1010, 150), 0.85),
    (front_path(1240, 1120, 90), 0.60),
]

core_l, glow_l, tick_l = layer(), layer(), layer()
dc, dg, dt = ImageDraw.Draw(core_l), ImageDraw.Draw(glow_l), ImageDraw.Draw(tick_l)
for pts, weight in fronts:
    w_core = max(1, int(2.6 * S * weight))
    dc.line(pts, fill=int(255 * weight), width=w_core, joint="curve")
    dg.line(pts, fill=int(200 * weight), width=int(7 * S), joint="curve")
    # Perpendicular ticks along the front, as on a tactical overlay.
    step = 9
    for i in range(step, len(pts) - step, step):
        (ax, ay), (bx, by) = pts[i - 2], pts[i + 2]
        dx, dy = bx - ax, by - ay
        ln = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / ln, dx / ln
        px0, py0 = pts[i]
        t_len = 17 * S * weight
        dt.line(
            [(px0, py0), (px0 + nx * t_len, py0 + ny * t_len)],
            fill=int(190 * weight),
            width=max(1, int(1.8 * S)),
        )

front_core = down(core_l, blur=0.4)
front_glow = down(glow_l, blur=11.0)
front_tick = down(tick_l, blur=0.4)

# --- trajectory arcs + markers ------------------------------------------------
arc_l, head_l, mark_l = layer(), layer(), layer()
da, dh, dm = ImageDraw.Draw(arc_l), ImageDraw.Draw(head_l), ImageDraw.Draw(mark_l)
for _ in range(7):
    x0, y0 = rng.uniform(0.02, 0.95) * W * S, rng.uniform(0.1, 0.9) * H * S
    ang = rng.uniform(0, math.tau)
    length = rng.uniform(0.16, 0.34) * W * S
    x1, y1 = x0 + math.cos(ang) * length, y0 + math.sin(ang) * length
    bow = rng.uniform(-0.22, 0.22) * length
    mx, my = (x0 + x1) / 2 - math.sin(ang) * bow, (y0 + y1) / 2 + math.cos(ang) * bow
    seg, prev = 64, None
    for i in range(seg + 1):
        u = i / seg
        bx = (1 - u) ** 2 * x0 + 2 * (1 - u) * u * mx + u**2 * x1
        by = (1 - u) ** 2 * y0 + 2 * (1 - u) * u * my + u**2 * y1
        if prev and i % 2 == 0:  # dashed
            da.line([prev, (bx, by)], fill=int(90 + 150 * u), width=max(1, int(1.6 * S)))
        prev = (bx, by)
    hr = 3.2 * S
    dh.ellipse([x1 - hr, y1 - hr, x1 + hr, y1 + hr], fill=255)

for _ in range(26):
    mx0, my0 = rng.uniform(0, W * S), rng.uniform(0, H * S)
    kind = int(rng.integers(0, 3))
    r0 = rng.uniform(5, 13) * S
    wid = max(1, int(1.5 * S))
    if kind == 0:
        dm.ellipse([mx0 - r0, my0 - r0, mx0 + r0, my0 + r0], outline=150, width=wid)
    elif kind == 1:
        dm.polygon(hex_pts(mx0, my0, r0), outline=135, width=wid)
    else:
        dm.line([(mx0 - r0, my0), (mx0 + r0, my0)], fill=140, width=wid)
        dm.line([(mx0, my0 - r0), (mx0, my0 + r0)], fill=140, width=wid)

arcs = down(arc_l, blur=0.5)
heads = down(head_l, blur=1.2)
heads_glow = down(head_l, blur=7.0)
marks = down(mark_l, blur=0.4)

# --- composite the vector layers ---------------------------------------------
# The lattice sits under everything, brightened slightly over high ground.
# Terrain-level marks sit under the vignette, so they fade toward the edges
# along with the map itself.
add(lattice * (0.45 + 0.55 * elev), AMBER_DIM, 0.85)
add(arcs, AMBER, 0.80)
add(marks, AMBER_DIM, 1.00)

# --- calm centre, vignette, grain --------------------------------------------
cx_, cy_ = 0.5, 0.42
rx = (xx - cx_) / 0.46
ry = (yy - cy_) / 0.52
dist = np.sqrt(rx * rx + ry * ry)

# Pull detail down where the lobby panel sits so the UI stays readable.
calm = np.clip(1.0 - dist * 1.25, 0.0, 1.0) ** 1.5
img *= (1.0 - 0.34 * calm)[:, :, None]

vig = np.clip(1.0 - (dist - 0.85) * 0.62, 0.0, 1.0)
img *= (0.50 + 0.50 * vig)[:, :, None]

# The contested cells are the subject, so they go on top of the vignette
# rather than under it -- they should hold up in the corners too. (The fronts
# do the same, but in their own layer further down.)
add(lit_fill, BRAND, 1.10)
add(lit_glow, BRAND, 0.90)
add(lit_edge, BRAND, 1.45)

grain = rng.normal(0.0, 1.0, (H, W)).astype(np.float32)
# Cheap 3x3 box blur so the grain reads as film rather than salt-and-pepper.
grain = sum(
    np.roll(np.roll(grain, dy, 0), dx, 1) for dy in (-1, 0, 1) for dx in (-1, 0, 1)
) / 9.0
img += grain[:, :, None] * 5.5



def knee(a, k=180.0):
    """Soft shoulder above `k` so bright accents roll off instead of clipping."""
    return np.where(a > k, k + (255.0 - k) * (1.0 - np.exp(-(a - k) / (255.0 - k))), a)


out_dir = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else OUT_DIR
out_dir.mkdir(parents=True, exist_ok=True)

field_img = Image.fromarray(np.clip(knee(img), 0, 255).astype(np.uint8), "RGB")
field_path = out_dir / FIELD_NAME
field_img.save(field_path, "WEBP", quality=82, method=6)
print("wrote", field_path, field_img.size)

# --- the animated layer: fronts on black -------------------------------------
# Kept as opaque RGB rather than RGBA: the page composites it with
# `mix-blend-mode: screen`, under which black contributes nothing, so the
# empty majority of the frame costs nothing visually and almost nothing on
# disk.
fimg = np.zeros((H, W, 3), np.float32)


def fadd(mask, color, gain):
    np.add(fimg, color[None, None, :] * mask[:, :, None] * gain, out=fimg)


fadd(front_glow, BRAND, 1.00)
fadd(front_tick, AMBER, 1.00)
fadd(front_core, HOT, 1.45)
fadd(heads_glow, SPARK, 0.85)
fadd(heads, SPARK, 1.10)

fronts_img = Image.fromarray(np.clip(knee(fimg), 0, 255).astype(np.uint8), "RGB")
fronts_path = out_dir / FRONTS_NAME
fronts_img.save(fronts_path, "WEBP", quality=84, method=6)
print("wrote", fronts_path, fronts_img.size)
