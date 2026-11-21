/**
 * Generates a map from OpenStreetMap data for the Go map generator.
 *
 *   npm run gen-osm-map -- --bbox=-80.5,40.4,-71.8,45.1 --name="US Northeast"
 *
 * Fetches the coastline, big lakes and administrative boundaries inside the
 * bounding box from the Overpass API (cached on disk), then writes
 * map-generator/assets/maps/<folder>/image.png and info.json with:
 *   - land and water from the coastline,
 *   - one nation per state/region (admin_level 4 by default), placed at the
 *     point farthest inside it, named after it, flagged by its country,
 *   - one named tribe per county-level area (admin_level 6 by default).
 * Then build it: `cd map-generator && go run -tags nodynamic . --maps=<folder>`
 * (or `npm run gen-maps` for every map).
 *
 * Options:
 *   --bbox=minLon,minLat,maxLon,maxLat   required
 *   --name="Display Name"                required (letters, digits, spaces)
 *   --size=2000          pixels on the long side
 *   --nations=4          admin_level for nations (2 = countries, 4 = states)
 *   --tribes=6           admin_level for tribes (6 = counties, 8 = towns)
 *   --category=countries map picker category
 *   --overpass=URL       Overpass endpoint
 *   --out=DIR            output folder (default map-generator/assets/maps/<id>)
 *
 * Map data © OpenStreetMap contributors, available under the ODbL.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import zlib from "zlib";
import {
  BBox,
  buildOsmMap,
  OsmElement,
  overpassQuery,
} from "../packages/shared/src/osm/OsmMapBuilder";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OVERPASS = "https://overpass-api.de/api/interpreter";

function args(): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of process.argv.slice(2)) {
    const m = /^--([a-z]+)=(.*)$/.exec(a);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

function parseBBox(s: string | undefined): BBox {
  const parts = (s ?? "").split(",").map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    throw new Error("--bbox=minLon,minLat,maxLon,maxLat is required");
  }
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (minLon >= maxLon || minLat >= maxLat) {
    throw new Error("--bbox: min must be below max");
  }
  return { minLon, minLat, maxLon, maxLat };
}

async function fetchOverpass(
  query: string,
  endpoint: string,
): Promise<OsmElement[]> {
  const cacheDir = path.join(os.tmpdir(), "brokenfront-osm-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const hash = crypto.createHash("sha256").update(query).digest("hex");
  const cacheFile = path.join(cacheDir, `${hash}.json`);
  if (fs.existsSync(cacheFile)) {
    console.log(`Using cached Overpass response ${cacheFile}`);
    return JSON.parse(fs.readFileSync(cacheFile, "utf8")).elements;
  }
  console.log(`Querying ${endpoint} (this can take a few minutes)...`);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "brokenfront-osm-map-generator",
    },
    body: new URLSearchParams({ data: query }).toString(),
  });
  if (!res.ok) {
    throw new Error(`Overpass returned ${res.status}: ${await res.text()}`);
  }
  const text = await res.text();
  fs.writeFileSync(cacheFile, text);
  return JSON.parse(text).elements;
}

/** Minimal RGBA PNG encoder. */
function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf: Buffer) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function toId(name: string): string {
  const words = name
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const id = words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  if (!/^[A-Z][A-Za-z0-9]*$/.test(id)) {
    throw new Error(`--name must start with a letter: ${name}`);
  }
  return id;
}

async function main() {
  const a = args();
  const bbox = parseBBox(a.get("bbox"));
  const name = a.get("name");
  if (!name || !/^[a-zA-Z0-9\s().-]{1,29}$/.test(name)) {
    throw new Error(
      '--name="Display Name" is required (up to 29 letters, digits, spaces, ().-)',
    );
  }
  const id = toId(name);
  const folder = id.toLowerCase();
  const nationLevel = Number(a.get("nations") ?? 4);
  const tribeLevel = Number(a.get("tribes") ?? 6);
  const longSide = Number(a.get("size") ?? 2000);
  const outDir =
    a.get("out") ?? path.join(ROOT, "map-generator", "assets", "maps", folder);

  const levels = [...new Set([2, nationLevel, tribeLevel])].sort();
  const elements = await fetchOverpass(
    overpassQuery(bbox, levels),
    a.get("overpass") ?? DEFAULT_OVERPASS,
  );
  console.log(`Got ${elements.length} OSM elements; rasterizing...`);
  const map = buildOsmMap(elements, bbox, {
    longSide,
    nationLevel,
    tribeLevel,
  });

  // Land is plains (blue 140); water is transparent (the generator's key).
  const rgba = new Uint8Array(map.width * map.height * 4);
  for (let i = 0; i < map.land.length; i++) {
    if (map.land[i]) {
      rgba[i * 4] = 190;
      rgba[i * 4 + 1] = 200;
      rgba[i * 4 + 2] = 140;
      rgba[i * 4 + 3] = 255;
    }
  }

  const flagsDir = path.join(ROOT, "resources", "flags");
  const flag = (country?: string) =>
    country && fs.existsSync(path.join(flagsDir, `${country}.svg`))
      ? country
      : "";
  const info = {
    $schema: "../../../info.schema.json",
    id,
    name,
    translation_key: `map.${folder}`,
    categories: [a.get("category") ?? "countries"],
    author: "© OpenStreetMap contributors",
    description: `${name}, generated from OpenStreetMap data (© OpenStreetMap contributors, ODbL).`,
    location: {
      lat: Math.round(((bbox.minLat + bbox.maxLat) / 2) * 100) / 100,
      lon: Math.round(((bbox.minLon + bbox.maxLon) / 2) * 100) / 100,
    },
    nations: map.nations.map((n) => ({
      coordinates: n.coordinates,
      flag: flag(n.country),
      name: n.name,
    })),
    custom_tribes: map.tribes.map((t) => ({
      name: t.name,
      coordinates: t.coordinates,
    })),
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "image.png"),
    encodePng(map.width, map.height, rgba),
  );
  fs.writeFileSync(
    path.join(outDir, "info.json"),
    JSON.stringify(info, null, 2) + "\n",
  );
  const landPct = Math.round(
    (100 * map.land.reduce((s, v) => s + v, 0)) / map.land.length,
  );
  console.log(
    `Wrote ${outDir}: ${map.width}x${map.height}, ${landPct}% land, ` +
      `${map.nations.length} nations, ${map.tribes.length} tribes.`,
  );
  console.log(
    `Next: cd map-generator && go run -tags nodynamic . --maps=${folder} ` +
      "&& cd .. && npm run gen-map-schema",
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
