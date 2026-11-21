import {
  GameMapType,
  GameMode,
  GameType,
} from "@openfront/engine-api/game/GameTypes";
import { Winner } from "@openfront/engine-api/Schemas";
import { ServerNewLobbyMessage } from "@openfront/shared/WireSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "../../src/server/Client";
import { GameManager } from "../../src/server/GameManager";
import {
  GamePhase,
  HOST_NEARBY_GRACE_MS,
  HOST_RETURN_GRACE_MS,
} from "../../src/server/GameServer";
import {
  cid,
  makeClient,
  makeGame,
  mockLogger,
  mockWsOf,
  startGame,
} from "../util/GameServerHarness";
import { sentServerMessages } from "../util/Wire";

// A private game's group stays together across games: when the game is
// decided the server opens the next lobby (same settings, same host) and
// tells everyone still connected where it is.

function newLobbyIds(client: Client): string[] {
  return sentServerMessages(mockWsOf(client))
    .filter((m): m is ServerNewLobbyMessage => m.type === "new_lobby")
    .map((m) => m.gameID);
}

function managerWithIds() {
  let n = 0;
  const mint = () => `NEXTLB0${++n}`;
  return new GameManager(mockLogger(), undefined, mint, false);
}

describe("persistent private lobby", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("runs onGameDecided once, when the winner vote settles", async () => {
    const onGameDecided = vi.fn();
    const game = makeGame({
      config: { gameType: GameType.Private },
      deps: { onGameDecided },
    });
    const a = makeClient({ clientID: cid("a"), ip: "1.1.1.1" });
    const b = makeClient({ clientID: cid("b"), ip: "2.2.2.2" });
    game.joinClient(a);
    game.joinClient(b);
    startGame(game);

    const winner: Winner = ["player", cid("a")];
    await mockWsOf(a).emit({ type: "winner", winner, allPlayersStats: {} });
    expect(onGameDecided).not.toHaveBeenCalled();
    await mockWsOf(b).emit({ type: "winner", winner, allPlayersStats: {} });
    expect(onGameDecided).toHaveBeenCalledTimes(1);
  });

  it("opens the next lobby with the same settings and host, and tells everyone", () => {
    const gm = managerWithIds();
    const previous = gm.createGame(
      "PREVGM01",
      { gameMap: GameMapType.Europe, gameMode: GameMode.Team, bots: 12 },
      "host-pid",
    )!;
    const host = makeClient({ persistentID: "host-pid" });
    const friend = makeClient({ persistentID: "friend-pid" });
    previous.joinClient(host);
    previous.joinClient(friend);

    const result = gm.createSuccessorLobby(previous);
    if (typeof result !== "object" || result === null) {
      throw new Error(`expected a lobby, got ${result}`);
    }
    const next = result.game;
    expect(result.created).toBe(true);
    expect(next.gameConfig.gameMap).toBe(GameMapType.Europe);
    expect(next.gameConfig.gameMode).toBe(GameMode.Team);
    expect(next.gameConfig.bots).toBe(12);
    expect(next.gameConfig.gameType).toBe(GameType.Private);
    expect(next.isCreator("host-pid")).toBe(true);
    expect(next.predecessorId).toBe("PREVGM01");
    expect(next.phase()).toBe(GamePhase.Lobby);
    expect(newLobbyIds(host)).toEqual([next.id]);
    expect(newLobbyIds(friend)).toEqual([next.id]);
  });

  it("does not copy the settings object, so the next lobby can change on its own", () => {
    const gm = managerWithIds();
    const previous = gm.createGame("PREVGM02", { bots: 5 }, "host-pid")!;
    previous.joinClient(makeClient({ persistentID: "host-pid" }));
    const result = gm.createSuccessorLobby(previous);
    if (typeof result !== "object" || result === null) throw new Error();
    result.game.gameConfig.bots = 99;
    expect(previous.gameConfig.bots).toBe(5);
  });

  it("is idempotent: a second call returns the lobby already opened", () => {
    const gm = managerWithIds();
    const previous = gm.createGame("PREVGM03", undefined, "host-pid")!;
    previous.joinClient(makeClient({ persistentID: "host-pid" }));
    const first = gm.createSuccessorLobby(previous);
    const second = gm.createSuccessorLobby(previous);
    if (typeof first !== "object" || first === null) throw new Error();
    if (typeof second !== "object" || second === null) throw new Error();
    expect(second.game).toBe(first.game);
    expect(second.created).toBe(false);
  });

  it("never opens a next lobby for a public game", () => {
    const gm = managerWithIds();
    const previous = gm.createGame("PREVGM04", {
      gameType: GameType.Public,
    })!;
    expect(gm.createSuccessorLobby(previous)).toBe("public");
  });

  it("hands hosting to a remaining player when the host already left the game", async () => {
    const gm = managerWithIds();
    const previous = gm.createGame("PREVGM05", undefined, "host-pid")!;
    const host = makeClient({ persistentID: "host-pid", ip: "1.1.1.1" });
    const friend = makeClient({ persistentID: "friend-pid", ip: "2.2.2.2" });
    previous.joinClient(host);
    previous.joinClient(friend);
    startGame(previous);
    await mockWsOf(host).trigger("close");

    const result = gm.createSuccessorLobby(previous);
    if (typeof result !== "object" || result === null) throw new Error();
    expect(result.game.isCreator("friend-pid")).toBe(true);
  });

  it("wires game decisions to the next lobby for games with a host", () => {
    const gm = managerWithIds();
    const previous = gm.createGame("PREVGM06", undefined, "host-pid")!;
    previous.joinClient(makeClient({ persistentID: "host-pid" }));
    // What settleWinner calls (driven end to end in the first test).
    (previous as any).deps.onGameDecided();
    expect(previous.successorLobby()).toBe("NEXTLB01");
    expect(gm.game("NEXTLB01")).not.toBeNull();
  });

  describe("waiting for the host in the next lobby", () => {
    function groupInNextLobby() {
      const gm = managerWithIds();
      const previous = gm.createGame("PREVGM07", undefined, "host-pid")!;
      const hostOnEndScreen = makeClient({ persistentID: "host-pid" });
      previous.joinClient(hostOnEndScreen);
      const result = gm.createSuccessorLobby(previous);
      if (typeof result !== "object" || result === null) throw new Error();
      const next = result.game;
      const friend = makeClient({ persistentID: "friend-pid" });
      next.joinClient(friend);
      // Real clients ping every few seconds; without it the long waits
      // below would prune everyone as stale.
      const wait = (ms: number) => {
        vi.advanceTimersByTime(ms);
        hostOnEndScreen.lastPing = Date.now();
        friend.lastPing = Date.now();
      };
      return { gm, previous, next, hostOnEndScreen, wait };
    }

    it("waits longer while the host is still on the finished game's end screen", () => {
      const { gm, next, wait } = groupInNextLobby();
      gm.tick();
      wait(HOST_RETURN_GRACE_MS + 1_000);
      gm.tick();
      expect(next.isCreator("host-pid")).toBe(true);

      wait(HOST_NEARBY_GRACE_MS);
      gm.tick();
      expect(next.isCreator("friend-pid")).toBe(true);
    });

    it("passes hosting on after the short wait once the host has gone", async () => {
      const { gm, next, hostOnEndScreen } = groupInNextLobby();
      await mockWsOf(hostOnEndScreen).trigger("close");
      gm.tick();
      vi.advanceTimersByTime(HOST_RETURN_GRACE_MS + 1_000);
      gm.tick();
      expect(next.isCreator("friend-pid")).toBe(true);
    });

    it("keeps the host once they arrive", () => {
      const { gm, next, wait } = groupInNextLobby();
      gm.tick();
      const host = makeClient({ persistentID: "host-pid" });
      next.joinClient(host);
      wait(HOST_NEARBY_GRACE_MS + 1_000);
      host.lastPing = Date.now();
      gm.tick();
      expect(next.isCreator("host-pid")).toBe(true);
    });
  });
});
