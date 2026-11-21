import { GameType } from "@openfront/engine-api/game/GameTypes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSocialReport,
  FriendInvites,
  friendStatusFor,
  INVITE_TTL_MS,
  mergeSocialReports,
  registerFriendRoutes,
} from "../../src/server/FriendPresence";
import { GameManager } from "../../src/server/GameManager";
import * as jwtModule from "../../src/server/jwt";
import type { SocialReport } from "../../src/server/SocialSchemas";
import { makeClient, mockLogger, startGame } from "../util/GameServerHarness";

function manager() {
  let n = 0;
  return new GameManager(mockLogger(), undefined, () => `NEXTLB0${++n}`, false);
}

describe("friend presence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe("buildSocialReport", () => {
    it("reports a signed-in player in a private lobby as joinable", () => {
      const gm = manager();
      const lobby = gm.createGame("PRIVLB01", undefined, "host-pid")!;
      lobby.joinClient(
        makeClient({ persistentID: "host-pid", publicId: "HOST" }),
      );
      lobby.joinClient(makeClient({ publicId: "GUEST" }));

      const report = buildSocialReport(gm, new FriendInvites());
      expect(report.presence).toEqual([
        expect.objectContaining({
          publicId: "HOST",
          gameID: "PRIVLB01",
          state: "lobby",
          joinGameID: "PRIVLB01",
          host: true,
        }),
        expect.objectContaining({
          publicId: "GUEST",
          state: "lobby",
          joinGameID: "PRIVLB01",
          host: undefined,
        }),
      ]);
    });

    it("leaves guests (no account) out", () => {
      const gm = manager();
      const lobby = gm.createGame("PRIVLB02", undefined, "host-pid")!;
      lobby.joinClient(makeClient({ persistentID: "host-pid" }));
      expect(buildSocialReport(gm, new FriendInvites()).presence).toEqual([]);
    });

    it("offers nothing to join in a public game", () => {
      const gm = manager();
      const game = gm.createGame("PUBLIC01", { gameType: GameType.Public })!;
      game.joinClient(makeClient({ publicId: "P1", ip: "1.1.1.1" }));
      game.joinClient(makeClient({ publicId: "P2", ip: "2.2.2.2" }));
      startGame(game);
      const report = buildSocialReport(gm, new FriendInvites());
      expect(report.presence).toHaveLength(2);
      for (const e of report.presence) {
        expect(e.state).toBe("in_game");
        expect(e.joinGameID).toBeUndefined();
      }
    });

    it("points a private game's players at the group's next lobby", () => {
      const gm = manager();
      const game = gm.createGame("PRIVGM01", undefined, "host-pid")!;
      game.joinClient(
        makeClient({
          persistentID: "host-pid",
          publicId: "HOST",
          ip: "1.1.1.1",
        }),
      );
      game.joinClient(makeClient({ publicId: "P2", ip: "2.2.2.2" }));
      startGame(game);

      // Under way, no next lobby yet: in a game, nothing to join.
      expect(
        buildSocialReport(gm, new FriendInvites()).presence[0].joinGameID,
      ).toBeUndefined();

      gm.createSuccessorLobby(game);
      const entry = buildSocialReport(gm, new FriendInvites()).presence.find(
        (e) => e.gameID === "PRIVGM01",
      )!;
      expect(entry.state).toBe("in_game");
      expect(entry.joinGameID).toBe("NEXTLB01");
    });

    it("drops invites to a lobby that has closed", () => {
      const gm = manager();
      const invites = new FriendInvites();
      invites.add({
        toPublicId: "B",
        fromPublicId: "A",
        fromName: "a",
        gameID: "GONEGM01",
        workerPath: "w0",
      });
      expect(buildSocialReport(gm, invites).invites).toEqual([]);
    });
  });

  describe("FriendInvites", () => {
    const base = {
      toPublicId: "B",
      fromPublicId: "A",
      fromName: "a",
      gameID: "PRIVLB01",
      workerPath: "w0",
    };
    const open = () => true;

    it("expires invites", () => {
      const invites = new FriendInvites();
      invites.add(base);
      expect(invites.live(open)).toHaveLength(1);
      vi.advanceTimersByTime(INVITE_TTL_MS + 1);
      expect(invites.live(open)).toEqual([]);
    });

    it("refreshes a repeat invite instead of stacking it", () => {
      const invites = new FriendInvites();
      invites.add(base);
      invites.add(base);
      expect(invites.live(open)).toHaveLength(1);
    });
  });

  describe("friendStatusFor", () => {
    const view: SocialReport = {
      presence: [
        { publicId: "FRIEND", gameID: "PUBLIC01", state: "in_game" },
        {
          publicId: "FRIEND",
          gameID: "PRIVLB01",
          state: "lobby",
          joinGameID: "PRIVLB01",
          host: true,
        },
        {
          publicId: "STRANGER",
          gameID: "PRIVLB02",
          state: "lobby",
          joinGameID: "PRIVLB02",
        },
      ],
      invites: [
        {
          id: "i1",
          toPublicId: "ME",
          fromPublicId: "FRIEND",
          fromName: "Friend",
          gameID: "PRIVLB01",
          workerPath: "w0",
          expiresAt: Date.now() + 60_000,
        },
        {
          id: "i2",
          toPublicId: "SOMEONE",
          fromPublicId: "FRIEND",
          fromName: "Friend",
          gameID: "PRIVLB01",
          workerPath: "w0",
          expiresAt: Date.now() + 60_000,
        },
        {
          id: "i3",
          toPublicId: "ME",
          fromPublicId: "STRANGER",
          fromName: "Stranger",
          gameID: "PRIVLB02",
          workerPath: "w0",
          expiresAt: Date.now() + 60_000,
        },
      ],
    };

    it("only shows the caller's friends, by their most joinable game", () => {
      const status = friendStatusFor("ME", ["FRIEND"], view);
      expect(status.friends).toEqual([
        {
          publicId: "FRIEND",
          state: "lobby",
          joinGameID: "PRIVLB01",
          host: true,
        },
      ]);
    });

    it("only shows invites to the caller, from a friend", () => {
      const status = friendStatusFor("ME", ["FRIEND"], view);
      expect(status.invites.map((i) => i.id)).toEqual(["i1"]);
    });

    it("never leaks other players' invites or the worker path", () => {
      const status = friendStatusFor("ME", ["FRIEND"], view);
      expect(JSON.stringify(status)).not.toContain("SOMEONE");
      expect(status.invites[0]).not.toHaveProperty("workerPath");
    });
  });

  it("merges per-worker reports", () => {
    const a: SocialReport = {
      presence: [{ publicId: "A", gameID: "GAMEAA01", state: "lobby" }],
      invites: [],
    };
    const b: SocialReport = {
      presence: [{ publicId: "B", gameID: "GAMEBB01", state: "in_game" }],
      invites: [],
    };
    expect(mergeSocialReports([a, b]).presence.map((e) => e.publicId)).toEqual([
      "A",
      "B",
    ]);
  });
});

describe("friend routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setup() {
    const handlers: Record<string, (req: any, res: any) => Promise<void>> = {};
    const capture = (path: string, ...rest: any[]) => {
      handlers[path] = rest[rest.length - 1];
    };
    const app: any = { get: capture, post: capture };
    const gm = manager();
    const invites = new FriendInvites();
    registerFriendRoutes({
      app,
      gm,
      invites,
      socialView: () => buildSocialReport(gm, invites),
      log: mockLogger(),
    });
    return { handlers, gm, invites };
  }

  // A signed-in caller with this publicId and friends list. Each call uses
  // its own token, since identities are cached per token.
  let tokenN = 0;
  function signIn(publicId: string, friends: string[]): string {
    const token = `tok-${++tokenN}`;
    vi.spyOn(jwtModule, "verifyClientToken").mockResolvedValue({
      type: "success",
      persistentId: `${publicId}-pid`,
      claims: { provider: "discord" } as any,
    });
    vi.spyOn(jwtModule, "getUserMe").mockResolvedValue({
      type: "success",
      response: { player: { publicId, friends, username: publicId } },
    } as any);
    return token;
  }

  function res() {
    return {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(data: unknown) {
        this.body = data;
        return this;
      },
      end() {
        return this;
      },
    };
  }

  function lobbyWith(gm: GameManager, publicId: string) {
    const lobby = gm.createGame("PRIVLB09", undefined, `${publicId}-pid`)!;
    lobby.joinClient(makeClient({ persistentID: `${publicId}-pid`, publicId }));
    return lobby;
  }

  const invite = (token: string, gameID: string, to: string) => ({
    headers: { authorization: `Bearer ${token}` },
    params: { id: gameID },
    body: { publicId: to },
  });

  it("lets a player in the lobby invite a friend, who then sees it", async () => {
    const { handlers, gm } = setup();
    lobbyWith(gm, "ALICE");
    const r = res();
    await handlers["/api/game/:id/invite"](
      invite(signIn("ALICE", ["BOB"]), "PRIVLB09", "BOB"),
      r,
    );
    expect(r.statusCode).toBe(204);

    const s = res();
    await handlers["/api/friends/status"](
      { headers: { authorization: `Bearer ${signIn("BOB", ["ALICE"])}` } },
      s,
    );
    const body = s.body as { friends: any[]; invites: any[] };
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0]).toMatchObject({
      fromPublicId: "ALICE",
      gameID: "PRIVLB09",
    });
    expect(body.friends[0]).toMatchObject({
      publicId: "ALICE",
      joinGameID: "PRIVLB09",
    });
  });

  it("refuses to invite someone who is not a friend", async () => {
    const { handlers, gm, invites } = setup();
    lobbyWith(gm, "ALICE");
    const r = res();
    await handlers["/api/game/:id/invite"](
      invite(signIn("ALICE", ["BOB"]), "PRIVLB09", "MALLORY"),
      r,
    );
    expect(r.statusCode).toBe(403);
    expect(r.body).toEqual({ error: "not_friend" });
    expect(invites.live(() => true)).toEqual([]);
  });

  it("refuses an invite from someone who is not in the lobby", async () => {
    const { handlers, gm } = setup();
    lobbyWith(gm, "ALICE");
    const r = res();
    await handlers["/api/game/:id/invite"](
      invite(signIn("BOB", ["CAROL"]), "PRIVLB09", "CAROL"),
      r,
    );
    expect(r.statusCode).toBe(403);
    expect(r.body).toEqual({ error: "not_in_lobby" });
  });

  it("refuses invites to a public game", async () => {
    const { handlers, gm } = setup();
    const game = gm.createGame("PUBLIC09", { gameType: GameType.Public })!;
    game.joinClient(makeClient({ publicId: "ALICE" }));
    const r = res();
    await handlers["/api/game/:id/invite"](
      invite(signIn("ALICE", ["BOB"]), "PUBLIC09", "BOB"),
      r,
    );
    expect(r.statusCode).toBe(403);
  });

  it("requires a signed-in caller for status", async () => {
    const { handlers } = setup();
    const r = res();
    await handlers["/api/friends/status"]({ headers: {} }, r);
    expect(r.statusCode).toBe(401);
  });
});
