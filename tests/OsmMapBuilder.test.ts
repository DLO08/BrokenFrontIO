import {
  assembleRings,
  BBox,
  buildOsmMap,
  fillRings,
  makeProjection,
  OsmElement,
  overpassQuery,
} from "@openfront/shared/osm/OsmMapBuilder";

const BBOX: BBox = { minLon: 0, minLat: 0, maxLon: 10, maxLat: 10 };

const pt = (lon: number, lat: number) => ({ lat, lon });

// A square island from lon/lat 2..8. OSM coastlines keep land on their
// left: counter-clockwise around an island.
const island: OsmElement = {
  type: "way",
  id: 1,
  tags: { natural: "coastline" },
  geometry: [pt(2, 2), pt(8, 2), pt(8, 8), pt(2, 8), pt(2, 2)],
};

// Two states splitting the island west/east, each drawn from two ways (as
// real multipolygons are) to exercise ring assembly.
function state(id: number, name: string, x0: number, x1: number): OsmElement {
  return {
    type: "relation",
    id,
    tags: {
      boundary: "administrative",
      admin_level: "4",
      name,
      "ISO3166-2": `XX-${name.slice(0, 2).toUpperCase()}`,
    },
    members: [
      {
        type: "way",
        ref: id * 10,
        role: "outer",
        geometry: [pt(x0, 2), pt(x1, 2), pt(x1, 8)],
      },
      {
        type: "way",
        ref: id * 10 + 1,
        role: "outer",
        geometry: [pt(x0, 2), pt(x0, 8), pt(x1, 8)],
      },
    ],
  };
}

const county: OsmElement = {
  type: "relation",
  id: 50,
  tags: { boundary: "administrative", admin_level: "6", name: "Northshire" },
  members: [
    {
      type: "way",
      ref: 500,
      role: "outer",
      geometry: [pt(3, 6), pt(7, 6), pt(7, 7.5), pt(3, 7.5), pt(3, 6)],
    },
  ],
};

describe("OSM map builder", () => {
  test("projection keeps sides multiples of 4 and the long side", () => {
    const proj = makeProjection(BBOX, 203);
    expect(proj.width % 4).toBe(0);
    expect(proj.height % 4).toBe(0);
    expect(Math.max(proj.width, proj.height)).toBeLessThanOrEqual(203);
    const [x, y] = proj.project(pt(5, 5));
    expect(x).toBeCloseTo(proj.width / 2, 0);
    expect(y).toBeGreaterThan(0);
  });

  test("joins split ways into a closed ring, either direction", () => {
    const rings = assembleRings([
      [pt(0, 0), pt(1, 0)],
      [pt(0, 1), pt(1, 1)].reverse(),
      [pt(1, 0), pt(1, 1)],
      [pt(0, 1), pt(0, 0)],
    ]);
    expect(rings).toHaveLength(1);
    expect(rings[0][0]).toEqual(rings[0][rings[0].length - 1]);
  });

  test("even-odd fill leaves holes", () => {
    const covered = new Set<string>();
    fillRings(
      [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
        [
          [3, 3],
          [7, 3],
          [7, 7],
          [3, 7],
        ],
      ],
      10,
      10,
      (x, y) => covered.add(`${x},${y}`),
    );
    expect(covered.has("1,1")).toBe(true);
    expect(covered.has("5,5")).toBe(false);
  });

  test("land comes from the coastline, nations from states", () => {
    const map = buildOsmMap(
      [
        island,
        state(10, "Westland", 2, 5),
        state(11, "Eastland", 5, 8),
        county,
      ],
      BBOX,
      { longSide: 200, minLakePixels: 1 },
    );
    const at = (lon: number, lat: number) => {
      const [x, y] = makeProjection(BBOX, 200).project(pt(lon, lat));
      return map.land[Math.floor(y) * map.width + Math.floor(x)];
    };
    expect(at(5, 5)).toBe(1); // island interior
    expect(at(0.5, 0.5)).toBe(0); // open sea
    expect(at(9.5, 5)).toBe(0);

    expect(map.nations.map((n) => n.name).sort()).toEqual([
      "Eastland",
      "Westland",
    ]);
    for (const n of map.nations) {
      const [x, y] = n.coordinates;
      expect(map.land[y * map.width + x]).toBe(1);
      expect(n.country).toBe("xx");
    }
    const west = map.nations.find((n) => n.name === "Westland")!;
    const east = map.nations.find((n) => n.name === "Eastland")!;
    expect(west.coordinates[0]).toBeLessThan(east.coordinates[0]);
    expect(map.tribes.map((t) => t.name)).toEqual(["Northshire"]);
  });

  test("an inland map with no coastline is all land under its states", () => {
    const map = buildOsmMap(
      [state(10, "Westland", 0, 5), state(11, "Eastland", 5, 10)],
      BBOX,
      { longSide: 100 },
    );
    expect(map.land.every((v) => v === 1)).toBe(true);
    expect(map.nations).toHaveLength(2);
  });

  test("is deterministic", () => {
    const els = [
      island,
      state(10, "Westland", 2, 5),
      state(11, "Eastland", 5, 8),
    ];
    const a = buildOsmMap(els, BBOX, { longSide: 120 });
    const b = buildOsmMap(els, BBOX, { longSide: 120 });
    expect(a.nations).toEqual(b.nations);
    expect(Buffer.from(a.land).equals(Buffer.from(b.land))).toBe(true);
  });

  test("the query asks for coastline, admin areas and lakes", () => {
    const q = overpassQuery(BBOX, [2, 4]);
    expect(q).toContain('"natural"="coastline"');
    expect(q).toContain('"admin_level"~"^(2|4)$"');
    expect(q).toContain("out geom;");
  });
});
