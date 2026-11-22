import { describe, expect, it } from "vitest";
import { BarPass } from "../../../../src/client/render/gl/passes/BarPass";
import type { UnitState } from "../../../../src/client/render/types";

const MAP_W = 100;
const MAX_BARS = 64;
const FLOATS = 4; // x, y, progress, kind

// Mirrors the maxHealth entries in engine-lib's Config.unitInfo().
const MAX_HEALTH: Record<string, number> = {
  Warship: 1000,
  "Aircraft Carrier": 2500,
  "Fishing Boat": 200,
  Fighter: 300,
};

const CONSTRUCTION_DURATION: Record<string, number> = {
  City: 20,
  "Missile Silo": 100,
};

function makePass() {
  const pass = Object.create(BarPass.prototype) as any;
  Object.assign(pass, {
    mapW: MAP_W,
    maxBars: MAX_BARS,
    veterancyHealthBonus: 10,
    maxHealthByType: new Map<string, number>(),
    healthData: new Float32Array(MAX_BARS * FLOATS),
    progressData: new Float32Array(MAX_BARS * FLOATS),
    veterancyData: new Float32Array(MAX_BARS * FLOATS),
    healthCount: 0,
    progressCount: 0,
    veterancyCount: 0,
    config: {
      unitInfo: (type: string) => ({
        maxHealth: MAX_HEALTH[type],
        constructionDuration: CONSTRUCTION_DURATION[type],
      }),
      deletionMarkDuration: () => 50,
      SiloCooldown: () => 100,
      SAMCooldown: () => 80,
    },
  });
  return pass;
}

function unit(over: Partial<UnitState>): UnitState {
  return {
    id: 1,
    unitType: "Warship",
    ownerID: 1,
    lastOwnerID: null,
    pos: 0,
    lastPos: 0,
    isActive: true,
    reachedTarget: false,
    retreating: false,
    targetable: true,
    waitTicks: 0,
    markedForDeletion: false,
    health: null,
    underConstruction: false,
    targetUnitId: null,
    targetTile: null,
    troops: 0,
    missileTimerQueue: [],
    level: 1,
    veterancy: 0,
    hasTrainStation: false,
    trainType: null,
    loaded: null,
    constructionStartTick: null,
    samUpgradeStartTick: null,
    samUpgradeStartRange: null,
    samUpgradeTargetLevel: null,
    samUpgradeDuration: null,
    ...over,
  } as UnitState;
}

/** The (progress, kind) pairs the pass pushed into one of its buffers. */
function bars(data: Float32Array, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    progress: data[i * FLOATS + 2],
    kind: data[i * FLOATS + 3],
  }));
}

describe("BarPass health bars", () => {
  it("measures each unit against its own max health", () => {
    const pass = makePass();
    pass.updateBars(
      new Map([
        // Full health: no bar at all, for any of them.
        [1, unit({ id: 1, unitType: "Fishing Boat", health: 200 })],
        [2, unit({ id: 2, unitType: "Fighter", health: 300 })],
        [3, unit({ id: 3, unitType: "Aircraft Carrier", health: 2500 })],
        [4, unit({ id: 4, unitType: "Warship", health: 1000 })],
      ]),
      new Map(),
      0,
    );

    expect(pass.healthCount).toBe(0);
  });

  it("does not draw a full fishing boat as a near-dead warship", () => {
    const pass = makePass();
    pass.updateBars(
      new Map([
        [1, unit({ id: 1, unitType: "Fishing Boat", health: 100 })],
        [2, unit({ id: 2, unitType: "Aircraft Carrier", health: 1250 })],
      ]),
      new Map(),
      0,
    );

    // Both are at half health, and both read as half — not 100/1000 = 10%
    // and 1250/1000 = "undamaged".
    expect(bars(pass.healthData, pass.healthCount)).toEqual([
      { progress: 0.5, kind: 0 },
      { progress: 0.5, kind: 0 },
    ]);
  });

  it("gives a veteran warship its higher max health", () => {
    const pass = makePass();
    pass.updateBars(
      // 1000 base + 2 levels x 10% = 1200 effective max.
      new Map([[1, unit({ unitType: "Warship", health: 1200, veterancy: 2 })]]),
      new Map(),
      0,
    );

    expect(pass.healthCount).toBe(0);
    expect(pass.veterancyCount).toBe(2);
  });
});

describe("BarPass progress bars", () => {
  it("tags construction, reload and deletion with distinct kinds", () => {
    const pass = makePass();
    pass.updateBars(
      new Map(),
      new Map([
        [
          1,
          unit({
            id: 1,
            unitType: "City",
            underConstruction: true,
            constructionStartTick: 0,
          }),
        ],
        [
          2,
          unit({
            id: 2,
            unitType: "Missile Silo",
            level: 2,
            missileTimerQueue: [0],
          }),
        ],
        [3, unit({ id: 3, unitType: "City", markedForDeletion: 25 })],
      ]),
      10,
    );

    const pushed = bars(pass.progressData, pass.progressCount);
    // Construction, reload and deletion each get their own color in the
    // shader, so what matters here is that they get their own kind.
    expect(pushed.map((b) => b.kind)).toEqual([1, 2, 3]);
    // 10 of 20 ticks built.
    expect(pushed[0].progress).toBeCloseTo(0.5, 5);
    // One of two missiles ready, the other 10 ticks into a 100-tick reload.
    expect(pushed[1].progress).toBeCloseTo(0.55, 5);
    // 15 of the 50-tick deletion countdown left.
    expect(pushed[2].progress).toBeCloseTo(0.3, 5);
  });

  it("skips a structure with nothing in progress", () => {
    const pass = makePass();
    pass.updateBars(new Map(), new Map([[1, unit({ unitType: "City" })]]), 10);

    expect(pass.progressCount).toBe(0);
  });
});
