import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { Config } from "@openfront/engine-lib/configuration/Config";
import {
  depositCount,
  rasterizeDeposits,
  seedUraniumDeposits,
} from "@openfront/engine-lib/game/ResourceDeposits";
import { AirStrikeExecution } from "@openfront/engine/execution/air/AirStrikeExecution";
import { BrokenfrontIntentExecution } from "@openfront/engine/execution/BrokenfrontIntentExecution";
import { ClusterNukeExecution } from "@openfront/engine/execution/ClusterNukeExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { OilRigExecution } from "@openfront/engine/execution/OilRigExecution";
import {
  findTransitPath,
  TroopColumnExecution,
} from "@openfront/engine/execution/TroopColumnExecution";
import { UraniumMineExecution } from "@openfront/engine/execution/UraniumMineExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";

const ON = {
  brokenfront: {
    uranium: true,
    alliedTransit: true,
    tradeDeals: true,
    airWar: true,
    seaEconomy: true,
  },
};

const humans = () => [
  new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
  new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
  new PlayerInfo("carol", PlayerType.Human, "client_c", "carol"),
];

/** Gives `p` every tile in the rectangle [x0,x1) x [y0,y1). */
function claim(
  game: Game,
  p: Player,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const t = game.ref(x, y);
      if (game.isLand(t)) p.conquer(t);
    }
  }
}

describe("uranium deposits", () => {
  test("are seeded deterministically on land, spaced apart", async () => {
    const game = await setup("big_plains", ON);
    const map = game.map();
    const a = seedUraniumDeposits(map);
    const b = seedUraniumDeposits(map);
    expect(a).toEqual(b);
    expect(a.length).toBe(depositCount(map.numLandTiles()));
    for (const d of a) {
      expect(map.isLand(map.ref(d.x, d.y))).toBe(true);
    }
    const mask = rasterizeDeposits(map, a);
    expect(mask[map.ref(a[0].x, a[0].y)]).toBe(1);
  });

  test("a manifest list replaces the seeded deposits", async () => {
    const game = await setup("big_plains", ON);
    game.setUraniumDeposits([{ x: 50, y: 50, r: 2 }]);
    expect(game.uraniumDeposits()).toEqual([{ x: 50, y: 50, r: 2 }]);
    expect(game.isUraniumDeposit(game.ref(51, 50))).toBe(true);
    expect(game.isUraniumDeposit(game.ref(53, 50))).toBe(false);
  });
});

describe("uranium mines and nuke costs", () => {
  let game: Game;
  let alice: Player;
  let bob: Player;

  beforeEach(async () => {
    game = await setup("big_plains", { ...ON, instantBuild: true }, humans());
    alice = game.player("alice");
    bob = game.player("bob");
    claim(game, alice, 0, 0, 60, 60);
    claim(game, bob, 100, 100, 160, 160);
    game.setUraniumDeposits([{ x: 30, y: 30, r: 3 }]);
    alice.addGold(100_000_000n);
  });

  test("a mine can only stand on a deposit", () => {
    expect(alice.canBuild(UnitType.UraniumMine, game.ref(5, 5))).toBe(false);
    expect(alice.canBuild(UnitType.UraniumMine, game.ref(30, 30))).not.toBe(
      false,
    );
  });

  test("a mine produces uranium by level", () => {
    const mine = alice.buildUnit(UnitType.UraniumMine, game.ref(30, 30), {});
    game.addExecution(new UraniumMineExecution(mine));
    const cycle = game.config().uraniumMineCycleTicks();
    executeTicks(game, cycle + 1);
    expect(alice.uranium()).toBe(1);
    mine.increaseLevel();
    executeTicks(game, cycle);
    expect(alice.uranium()).toBe(3);
    expect(alice.uraniumMined()).toBe(3);
  });

  test("nukes cost uranium on top of gold", () => {
    alice.buildUnit(UnitType.MissileSilo, game.ref(10, 10), {});
    const target = game.ref(130, 130);
    expect(alice.canBuild(UnitType.AtomBomb, target)).toBe(false);
    alice.addUranium(10);
    expect(alice.canBuild(UnitType.AtomBomb, target)).not.toBe(false);
    alice.buildUnit(UnitType.AtomBomb, game.ref(10, 10), {
      targetTile: target,
      trajectory: [],
    });
    expect(alice.uranium()).toBe(0);
  });

  test("cluster nukes need a level-2 silo and split into five warheads", () => {
    alice.addUranium(1000);
    const silo = alice.buildUnit(UnitType.MissileSilo, game.ref(10, 10), {});
    const target = game.ref(130, 130);
    expect(alice.canBuild(UnitType.ClusterNuke, target)).toBe(false);
    silo.increaseLevel();
    expect(alice.canBuild(UnitType.ClusterNuke, target)).not.toBe(false);
    const exec = new ClusterNukeExecution(alice, target);
    game.addExecution(exec);
    let warheadsSeen = 0;
    for (let i = 0; i < 200 && warheadsSeen < 5; i++) {
      executeTicks(game, 1);
      warheadsSeen = Math.max(
        warheadsSeen,
        alice.units(UnitType.ClusterWarhead).length,
      );
    }
    expect(warheadsSeen).toBe(5);
    expect(exec.isActive()).toBe(false);
    // The warheads ride out each other's blasts and all land.
    executeTicks(game, 100);
    expect(alice.units(UnitType.ClusterWarhead)).toHaveLength(0);
    expect(bob.numTilesOwned()).toBeLessThan(60 * 60);
  });

  test("large nukes sit between atom and hydrogen bombs", () => {
    // TestConfig stubs the magnitudes; read the real rules.
    const mag = (t: UnitType) =>
      Config.prototype.nukeMagnitudes.call(game.config(), t);
    const large = mag(UnitType.LargeNuke);
    expect(large.outer).toBeGreaterThan(mag(UnitType.AtomBomb).outer);
    expect(large.outer).toBeLessThan(mag(UnitType.HydrogenBomb).outer);
  });

  // The client launches through a build_unit intent, which the executor turns
  // into a ConstructionExecution; drive the same path end to end.
  test.each([
    [UnitType.LargeNuke, 1],
    [UnitType.ClusterNuke, 2],
  ])("a %s launched by intent lands on its target", (type, siloLevel) => {
    alice.addUranium(1000);
    const silo = alice.buildUnit(UnitType.MissileSilo, game.ref(10, 10), {});
    for (let l = 1; l < siloLevel; l++) silo.increaseLevel();
    const target = game.ref(130, 130);
    const goldBefore = alice.gold();
    const bobTilesBefore = bob.numTilesOwned();

    game.addExecution(new ConstructionExecution(alice, type, target));
    executeTicks(game, 300);

    expect(alice.gold()).toBeLessThan(goldBefore);
    expect(alice.uranium()).toBe(1000 - game.config().uraniumCost(type));
    expect(bob.numTilesOwned()).toBeLessThan(bobTilesBefore);
  });
});

describe("offshore oil rigs", () => {
  test("stand on water near your coast and pay gold", async () => {
    const game = await setup(
      "half_land_half_ocean",
      { ...ON, instantBuild: true },
      humans(),
    );
    const alice = game.player("alice");
    claim(game, alice, 0, 0, 16, 16);
    alice.addGold(10_000_000n);
    let water = -1;
    for (let x = 0; x < 16 && water === -1; x++) {
      const t = game.ref(x, 8);
      if (game.isWater(t)) water = t;
    }
    expect(water).not.toBe(-1);
    expect(alice.canBuild(UnitType.OilRig, game.ref(2, 8))).toBe(false);
    expect(alice.canBuild(UnitType.OilRig, water)).toBe(water);
    const rig = alice.buildUnit(UnitType.OilRig, water, {});
    game.addExecution(new OilRigExecution(rig));
    const before = alice.gold();
    executeTicks(game, game.config().oilRigCycleTicks() + 1);
    expect(rig.isActive()).toBe(true);
    expect(alice.gold() - before).toBeGreaterThanOrEqual(
      game.config().oilRigGold(1, alice),
    );
  });
});

describe("trade book", () => {
  let game: Game;
  let alice: Player;
  let bob: Player;

  beforeEach(async () => {
    game = await setup("big_plains", ON, humans());
    alice = game.player("alice");
    bob = game.player("bob");
    claim(game, alice, 0, 0, 30, 30);
    claim(game, bob, 100, 100, 130, 130);
  });

  const run = (
    p: Player,
    intent: ConstructorParameters<typeof BrokenfrontIntentExecution>[1],
  ) => {
    game.addExecution(new BrokenfrontIntentExecution(p, intent));
    executeTicks(game, 2);
  };

  test("agreements are proposed, accepted and pay a bonus", () => {
    run(alice, { type: "trade_agreement", action: "request", other: bob.id() });
    expect(game.trade().hasRequest(alice, bob)).toBe(true);
    run(bob, { type: "trade_agreement", action: "accept", other: alice.id() });
    expect(game.trade().isPartner(alice, bob)).toBe(true);
    const split = game.trade().tradeShipSplit(alice, bob, 1000n);
    expect(split).toEqual({ src: 1250n, dst: 1250n });
    // An embargo ends the agreement.
    alice.addEmbargo(bob, false);
    executeTicks(game, 1);
    expect(game.trade().isPartner(alice, bob)).toBe(false);
  });

  test("tariffs shift a share of non-partner trade to the destination", () => {
    run(bob, { type: "set_tariff", pct: 10 });
    expect(game.trade().tradeShipSplit(alice, bob, 1000n)).toEqual({
      src: 900n,
      dst: 1100n,
    });
  });

  test("offers swap resources all-or-nothing", () => {
    alice.addGold(5000n);
    bob.addUranium(3);
    run(alice, {
      type: "trade_offer",
      recipient: bob.id(),
      giveGold: 5000,
      giveUranium: 0,
      wantGold: 0,
      wantUranium: 3,
    });
    const offer = game.trade().offersFor(bob)[0];
    expect(offer).toBeDefined();
    const aliceGold = alice.gold();
    run(bob, { type: "trade_offer_reply", offerId: offer.id, accept: true });
    expect(alice.uranium()).toBe(3);
    expect(bob.uranium()).toBe(0);
    expect(aliceGold - alice.gold()).toBeGreaterThanOrEqual(5000n - 1000n);
  });

  test("the uranium market moves with demand", () => {
    alice.addGold(100_000_000n);
    const p0 = game.trade().marketPrice();
    run(alice, { type: "market_trade", side: "buy", amount: 10 });
    expect(alice.uranium()).toBe(10);
    expect(game.trade().marketPrice()).toBeGreaterThan(p0);
  });
});

describe("air war", () => {
  let game: Game;
  let alice: Player;
  let bob: Player;

  beforeEach(async () => {
    game = await setup("big_plains", { ...ON, instantBuild: true }, humans());
    alice = game.player("alice");
    bob = game.player("bob");
    claim(game, alice, 0, 0, 40, 40);
    claim(game, bob, 60, 60, 120, 120);
    alice.addGold(100_000_000n);
    alice.addTroops(100_000);
  });

  test("a bomber knocks a level off enemy structures", () => {
    alice.buildUnit(UnitType.Airbase, game.ref(20, 20), {});
    const city = bob.buildUnit(UnitType.City, game.ref(80, 80), {});
    city.increaseLevel();
    game.addExecution(new AirStrikeExecution(alice, game.ref(80, 80), "bomb"));
    executeTicks(game, 80);
    expect(city.level()).toBe(1);
    // It flies home and frees its slot.
    expect(alice.units(UnitType.Bomber)).toHaveLength(0);
  });

  test("you cannot bomb an ally", () => {
    alice.buildUnit(UnitType.Airbase, game.ref(20, 20), {});
    expect(alice.canBuild(UnitType.Bomber, game.ref(10, 10))).toBe(false);
  });

  test("paratroopers land a bridgehead", () => {
    alice.buildUnit(UnitType.Airbase, game.ref(20, 20), {});
    const tilesBefore = alice.numTilesOwned();
    game.addExecution(
      new AirStrikeExecution(alice, game.ref(90, 90), "paratroop", 5_000),
    );
    executeTicks(game, 60);
    expect(alice.numTilesOwned()).toBeGreaterThan(tilesBefore);
    expect(game.owner(game.ref(90, 90))).toBe(alice);
  });
});

describe("allied transit", () => {
  test("troops march through an ally to attack its neighbour", async () => {
    const game = await setup("big_plains", ON, humans());
    const alice = game.player("alice");
    const bob = game.player("bob");
    const carol = game.player("carol");
    claim(game, alice, 0, 0, 20, 40);
    claim(game, bob, 20, 0, 40, 40);
    claim(game, carol, 40, 0, 60, 40);
    alice.addTroops(50_000);
    const req = alice.createAllianceRequest(bob);
    req!.accept();
    expect(alice.isAlliedWith(bob)).toBe(true);

    const dst = game.ref(45, 20);
    const path = findTransitPath(game, alice, dst);
    expect(path).not.toBeNull();
    expect(game.owner(path![0])).toBe(alice);
    expect(game.owner(path![path!.length - 1])).toBe(bob);

    const carolTiles = carol.numTilesOwned();
    game.addExecution(new TroopColumnExecution(alice, dst, 20_000));
    executeTicks(game, 200);
    expect(carol.numTilesOwned()).toBeLessThan(carolTiles);
  });

  test("no corridor without an ally", async () => {
    const game = await setup("big_plains", ON, humans());
    const alice = game.player("alice");
    const bob = game.player("bob");
    const carol = game.player("carol");
    claim(game, alice, 0, 0, 20, 40);
    claim(game, bob, 20, 0, 40, 40);
    claim(game, carol, 40, 0, 60, 40);
    expect(findTransitPath(game, alice, game.ref(45, 20))).toBeNull();
  });
});
