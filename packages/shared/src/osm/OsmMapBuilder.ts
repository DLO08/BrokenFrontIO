/**
 * Builds a BrokenFront map from OpenStreetMap data (© OpenStreetMap
 * contributors, ODbL): a land/water raster from the coastline and big lakes,
 * nations at the inner-most point of each state/region, and tribes at the
 * inner-most point of each smaller administrative area.
 *
 * Pure and dependency-free (no Node or DOM APIs), so the CLI
 * (scripts/osmMap.ts) and a server can share it. Fetching is left to the
 * caller: pass the Overpass JSON `elements` for overpassQuery(bbox).
 */

export interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

export interface OsmMember {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
  geometry?: LatLon[];
}

export interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  tags?: Record<string, string>;
  geometry?: LatLon[];
  members?: OsmMember[];
}

export interface OsmMapOptions {
  /** Pixels on the long side (rounded down to a multiple of 4). */
  longSide?: number;
  /** admin_level of the regions that become nations (4 = states). */
  nationLevel?: number;
  /** admin_level of the areas that become named tribes (6 = counties). */
  tribeLevel?: number;
  /** Most tribes to emit (the game caps tribes at 1000). */
  maxTribes?: number;
  /** Water blobs smaller than this (pixels) are filled in as land. */
  minLakePixels?: number;
}

export interface OsmPlace {
  name: string;
  coordinates: [number, number];
  /** ISO 3166-1 alpha-2 country code, lower case, when the data has one. */
  country?: string;
}

export interface OsmMap {
  width: number;
  height: number;
  /** 1 = land, 0 = water, row-major. */
  land: Uint8Array;
  nations: OsmPlace[];
  tribes: OsmPlace[];
}

const DEFAULTS: Required<OsmMapOptions> = {
  longSide: 2000,
  nationLevel: 4,
  tribeLevel: 6,
  maxTribes: 1000,
  minLakePixels: 30,
};

/** The Overpass QL query that fetches everything buildOsmMap needs. */
export function overpassQuery(
  bbox: BBox,
  levels: readonly number[] = [2, 4, 6],
): string {
  const b = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
  const lv = levels.join("|");
  return [
    "[out:json][timeout:300];",
    "(",
    `  way["natural"="coastline"](${b});`,
    `  relation["boundary"="administrative"]["admin_level"~"^(${lv})$"](${b});`,
    `  relation["natural"="water"](${b});`,
    ");",
    "out geom;",
  ].join("\n");
}

// --- Projection ------------------------------------------------------------

function mercY(lat: number): number {
  const clamped = Math.max(-85, Math.min(85, lat));
  return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
}

export interface Projection {
  width: number;
  height: number;
  /** Fractional pixel position of a coordinate. */
  project(p: LatLon): [number, number];
  /** Coordinate at the centre of pixel (x, y). */
  unproject(x: number, y: number): LatLon;
}

/** Web Mercator fitted to `bbox`, long side `longSide` px, sides % 4 === 0. */
export function makeProjection(bbox: BBox, longSide: number): Projection {
  const spanX = ((bbox.maxLon - bbox.minLon) * Math.PI) / 180;
  const top = mercY(bbox.maxLat);
  const bottom = mercY(bbox.minLat);
  const spanY = top - bottom;
  if (!(spanX > 0) || !(spanY > 0)) {
    throw new Error("bounding box must have positive width and height");
  }
  const scale = longSide / Math.max(spanX, spanY);
  const round4 = (v: number) => Math.max(4, Math.floor(v / 4) * 4);
  const width = round4(spanX * scale);
  const height = round4(spanY * scale);
  return {
    width,
    height,
    project: (p) => [
      (((p.lon - bbox.minLon) * Math.PI) / 180) * (width / spanX),
      (top - mercY(p.lat)) * (height / spanY),
    ],
    unproject: (x, y) => {
      const lon =
        bbox.minLon + ((x + 0.5) / width) * (bbox.maxLon - bbox.minLon);
      const my = top - ((y + 0.5) / height) * spanY;
      const lat = ((2 * Math.atan(Math.exp(my)) - Math.PI / 2) * 180) / Math.PI;
      return { lat, lon };
    },
  };
}

// --- Rings -------------------------------------------------------------------

type Ring = [number, number][];

const key = (p: LatLon) => `${p.lat},${p.lon}`;

/**
 * Joins way geometries end to end into closed rings (OSM multipolygons are
 * split across many ways, in any direction). Unclosable chains are closed
 * straight back to their start.
 */
export function assembleRings(ways: LatLon[][]): LatLon[][] {
  const pending = ways.filter((w) => w.length >= 2).map((w) => w.slice());
  const rings: LatLon[][] = [];
  while (pending.length > 0) {
    let ring = pending.shift()!;
    let progressed = true;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && progressed) {
      progressed = false;
      const end = key(ring[ring.length - 1]);
      for (let i = 0; i < pending.length; i++) {
        const w = pending[i];
        if (key(w[0]) === end) {
          ring = ring.concat(w.slice(1));
        } else if (key(w[w.length - 1]) === end) {
          ring = ring.concat(w.slice(0, -1).reverse());
        } else {
          continue;
        }
        pending.splice(i, 1);
        progressed = true;
        break;
      }
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

function relationRings(rel: OsmElement): LatLon[][] {
  const ways = (rel.members ?? [])
    .filter((m) => m.type === "way" && m.geometry && m.geometry.length >= 2)
    .map((m) => m.geometry!);
  return assembleRings(ways);
}

// --- Rasterizing ---------------------------------------------------------------

/**
 * Even-odd scanline fill of `rings` (pixel centres), calling `paint` for
 * every covered pixel. Holes (inner rings) fall out of the even-odd rule.
 * Edges are bucketed by row, so the cost is the edges' vertical extent.
 */
export function fillRings(
  rings: Ring[],
  width: number,
  height: number,
  paint: (x: number, y: number) => void,
): void {
  const rows: number[][] = Array.from({ length: height }, () => []);
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % ring.length];
      if (y0 === y1) continue;
      const yMin = Math.min(y0, y1);
      const yMax = Math.max(y0, y1);
      const rowStart = Math.max(0, Math.ceil(yMin - 0.5));
      const rowEnd = Math.min(height - 1, Math.ceil(yMax - 0.5) - 1);
      for (let row = rowStart; row <= rowEnd; row++) {
        const yc = row + 0.5;
        const t = (yc - y0) / (y1 - y0);
        rows[row].push(x0 + t * (x1 - x0));
      }
    }
  }
  for (let row = 0; row < height; row++) {
    const xs = rows[row];
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const from = Math.max(0, Math.ceil(xs[i] - 0.5));
      const to = Math.min(width - 1, Math.ceil(xs[i + 1] - 0.5) - 1);
      for (let x = from; x <= to; x++) paint(x, row);
    }
  }
}

/** Bresenham line between two fractional pixel positions. */
function drawLine(
  a: [number, number],
  b: [number, number],
  width: number,
  height: number,
  paint: (x: number, y: number) => void,
): void {
  let x0 = Math.floor(a[0]);
  let y0 = Math.floor(a[1]);
  const x1 = Math.floor(b[0]);
  const y1 = Math.floor(b[1]);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 100_000; guard++) {
    if (x0 >= 0 && y0 >= 0 && x0 < width && y0 < height) paint(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** 4-connected components of the pixels where `open` is 1. */
function components(
  open: Uint8Array,
  width: number,
  height: number,
): { ids: Int32Array; count: number } {
  const ids = new Int32Array(width * height).fill(-1);
  const stack: number[] = [];
  let count = 0;
  for (let start = 0; start < ids.length; start++) {
    if (!open[start] || ids[start] !== -1) continue;
    ids[start] = count;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % width;
      const y = (p - x) / width;
      const visit = (q: number) => {
        if (open[q] && ids[q] === -1) {
          ids[q] = count;
          stack.push(q);
        }
      };
      if (x > 0) visit(p - 1);
      if (x < width - 1) visit(p + 1);
      if (y > 0) visit(p - width);
      if (y < height - 1) visit(p + width);
    }
    count++;
  }
  return { ids, count };
}

// --- Land mask -------------------------------------------------------------------

/**
 * Land/water from the coastline. OSM coastlines run with land on their left,
 * so after cutting the raster along every coastline way, each piece is land
 * or water by the side most coastline segments put it on. Pieces no
 * coastline touches are land when an administrative area covers most of
 * them (an inland map has no coastline at all).
 */
function landMask(
  elements: OsmElement[],
  proj: Projection,
  adminCover: Uint8Array,
): Uint8Array {
  const { width, height } = proj;
  const n = width * height;
  const coast = new Uint8Array(n);
  const coastWays = elements.filter(
    (e) => e.type === "way" && e.tags?.natural === "coastline" && e.geometry,
  );
  const segments: [[number, number], [number, number]][] = [];
  for (const way of coastWays) {
    const pts = way.geometry!.map((p) => proj.project(p));
    for (let i = 0; i + 1 < pts.length; i++) {
      segments.push([pts[i], pts[i + 1]]);
      drawLine(pts[i], pts[i + 1], width, height, (x, y) => {
        coast[y * width + x] = 1;
      });
    }
  }

  const open = new Uint8Array(n);
  for (let i = 0; i < n; i++) open[i] = coast[i] ? 0 : 1;
  const { ids, count } = components(open, width, height);
  const landVotes = new Int32Array(count);
  const waterVotes = new Int32Array(count);
  const sample = (x: number, y: number): number => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return -1;
    return ids[yi * width + xi];
  };
  for (const [a, b] of segments) {
    const px = b[0] - a[0];
    const py = b[1] - a[1];
    const len = Math.hypot(px, py);
    if (len === 0) continue;
    // Geographic left of the way, in pixel space (y grows downward).
    const nx = py / len;
    const ny = -px / len;
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    for (const d of [1.5, 2.5]) {
      const l = sample(mx + nx * d, my + ny * d);
      const w = sample(mx - nx * d, my - ny * d);
      if (l >= 0) landVotes[l]++;
      if (w >= 0) waterVotes[w]++;
    }
  }

  const covered = new Int32Array(count);
  const size = new Int32Array(count);
  for (let i = 0; i < n; i++) {
    const c = ids[i];
    if (c < 0) continue;
    size[c]++;
    if (adminCover[i]) covered[c]++;
  }
  const hasAdmin = adminCover.some((v) => v === 1);
  const isLand = new Uint8Array(count);
  for (let c = 0; c < count; c++) {
    if (landVotes[c] + waterVotes[c] > 0) {
      isLand[c] = landVotes[c] >= waterVotes[c] ? 1 : 0;
    } else {
      isLand[c] = !hasAdmin || covered[c] * 2 >= size[c] ? 1 : 0;
    }
  }

  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (ids[i] >= 0) land[i] = isLand[ids[i]];
  }
  // Coastline pixels join whichever side most of their neighbours are on.
  for (let i = 0; i < n; i++) {
    if (!coast[i]) continue;
    const x = i % width;
    const y = (i - x) / width;
    let l = 0;
    let t = 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      const q = yy * width + xx;
      if (coast[q]) continue;
      t++;
      l += land[q];
    }
    land[i] = t > 0 && l * 2 >= t ? 1 : 0;
  }
  return land;
}

/** Fills water blobs smaller than `minPixels` (specks, rivers' stubs). */
function fillSmallWater(
  land: Uint8Array,
  width: number,
  height: number,
  minPixels: number,
): void {
  const water = new Uint8Array(land.length);
  for (let i = 0; i < land.length; i++) water[i] = land[i] ? 0 : 1;
  const { ids, count } = components(water, width, height);
  const size = new Int32Array(count);
  for (const c of ids) if (c >= 0) size[c]++;
  for (let i = 0; i < land.length; i++) {
    if (ids[i] >= 0 && size[ids[i]] < minPixels) land[i] = 1;
  }
}

// --- Places ---------------------------------------------------------------------

/**
 * For each label (1..count), the land pixel farthest from its region's edge:
 * a multi-source BFS from every edge pixel, so a spawn point sits deep
 * inside its region rather than at a centroid that may fall in the sea.
 */
function innerPoints(
  labels: Int32Array,
  count: number,
  width: number,
  height: number,
): ([number, number] | null)[] {
  const n = width * height;
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (l <= 0) continue;
    const x = i % width;
    const y = (i - x) / width;
    const edge =
      x === 0 ||
      y === 0 ||
      x === width - 1 ||
      y === height - 1 ||
      labels[i - 1] !== l ||
      labels[i + 1] !== l ||
      labels[i - width] !== l ||
      labels[i + width] !== l;
    if (edge) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const p = queue[head++];
    const x = p % width;
    const y = (p - x) / width;
    const l = labels[p];
    const visit = (q: number) => {
      if (dist[q] === -1 && labels[q] === l) {
        dist[q] = dist[p] + 1;
        queue[tail++] = q;
      }
    };
    if (x > 0) visit(p - 1);
    if (x < width - 1) visit(p + 1);
    if (y > 0) visit(p - width);
    if (y < height - 1) visit(p + width);
  }
  const best: ([number, number] | null)[] = new Array(count + 1).fill(null);
  const bestDist = new Int32Array(count + 1).fill(-1);
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (l <= 0 || dist[i] <= bestDist[l]) continue;
    bestDist[l] = dist[i];
    const x = i % width;
    best[l] = [x, (i - x) / width];
  }
  return best;
}

function displayName(tags: Record<string, string> | undefined): string | null {
  const name = tags?.["name:en"] ?? tags?.name;
  if (!name) return null;
  return name.trim().slice(0, 60) || null;
}

function countryOf(
  tags: Record<string, string> | undefined,
): string | undefined {
  const iso2 = tags?.["ISO3166-2"];
  if (iso2 && /^[A-Za-z]{2}-/.test(iso2)) return iso2.slice(0, 2).toLowerCase();
  const iso1 = tags?.["ISO3166-1:alpha2"] ?? tags?.["ISO3166-1"];
  if (iso1 && /^[A-Za-z]{2}$/.test(iso1)) return iso1.toLowerCase();
  return undefined;
}

/** Places (one per named admin area of `level`) on land, at inner points. */
function places(
  admins: OsmElement[],
  level: number,
  proj: Projection,
  land: Uint8Array,
  limit: number,
): OsmPlace[] {
  const { width, height } = proj;
  const areas = admins
    .filter((r) => r.tags?.admin_level === String(level) && displayName(r.tags))
    .sort((a, b) => a.id - b.id);
  const labels = new Int32Array(width * height);
  const kept: OsmElement[] = [];
  for (const rel of areas) {
    const rings = relationRings(rel).map((r) => r.map((p) => proj.project(p)));
    if (rings.length === 0) continue;
    const label = kept.length + 1;
    let painted = 0;
    fillRings(rings, width, height, (x, y) => {
      const i = y * width + x;
      if (land[i]) {
        labels[i] = label;
        painted++;
      }
    });
    if (painted > 0) kept.push(rel);
  }
  const points = innerPoints(labels, kept.length, width, height);
  const out: OsmPlace[] = [];
  const seen = new Set<string>();
  kept.forEach((rel, i) => {
    const pt = points[i + 1];
    const name = displayName(rel.tags)!;
    if (pt === null || seen.has(name)) return;
    seen.add(name);
    out.push({ name, coordinates: pt, country: countryOf(rel.tags) });
  });
  return out.slice(0, limit);
}

// --- Entry point -------------------------------------------------------------------

/** Builds the land raster, nations and tribes for `bbox` from Overpass data. */
export function buildOsmMap(
  elements: OsmElement[],
  bbox: BBox,
  options: OsmMapOptions = {},
): OsmMap {
  const opts = { ...DEFAULTS, ...options };
  const proj = makeProjection(bbox, opts.longSide);
  const { width, height } = proj;
  const admins = elements.filter(
    (e) => e.type === "relation" && e.tags?.boundary === "administrative",
  );

  // Where any country/state is: decides land for pieces no coast touches.
  const adminCover = new Uint8Array(width * height);
  for (const rel of admins) {
    const lvl = Number(rel.tags?.admin_level);
    if (lvl !== 2 && lvl !== opts.nationLevel) continue;
    const rings = relationRings(rel).map((r) => r.map((p) => proj.project(p)));
    fillRings(rings, width, height, (x, y) => {
      adminCover[y * width + x] = 1;
    });
  }

  const land = landMask(elements, proj, adminCover);

  // Big lakes (natural=water multipolygons).
  for (const rel of elements) {
    if (rel.type !== "relation" || rel.tags?.natural !== "water") continue;
    const rings = relationRings(rel).map((r) => r.map((p) => proj.project(p)));
    fillRings(rings, width, height, (x, y) => {
      land[y * width + x] = 0;
    });
  }
  fillSmallWater(land, width, height, opts.minLakePixels);

  let nations = places(admins, opts.nationLevel, proj, land, 400);
  if (nations.length < 2 && opts.nationLevel !== 2) {
    nations = places(admins, 2, proj, land, 400);
  }
  const nationNames = new Set(nations.map((n) => n.name));
  const tribes = places(
    admins,
    opts.tribeLevel,
    proj,
    land,
    opts.maxTribes,
  ).filter((t) => !nationNames.has(t.name));
  return { width, height, land, nations, tribes };
}
