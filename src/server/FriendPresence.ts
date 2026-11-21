import { ID } from "@openfront/engine-api/Schemas";
import {
  type FriendInvite,
  type FriendPresenceEntry,
  type FriendStatusResponse,
} from "@openfront/shared/FriendSchemas";
import { generateID } from "@openfront/shared/SharedUtil";
import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { GameManager } from "./GameManager";
import { GamePhase } from "./GameServer";
import { getUserMe, verifyClientToken } from "./jwt";
import type { logger } from "./Logger";
import { ServerEnv } from "./ServerEnv";
import {
  type SocialEntry,
  type SocialInvite,
  type SocialReport,
} from "./SocialSchemas";

export { EMPTY_SOCIAL } from "./SocialSchemas";

// Friend presence ("which of my friends are in a lobby I can join") and lobby
// invites, for the Friends page and the lobby invite panel.
//
// Every worker knows only its own games, so each reports a SocialReport to
// the master with its lobby list (WorkerLobbyService) and the master
// broadcasts the merged view back to every worker. Any worker can then answer
// a /api/friends/status request. The view covers this server's workers only:
// friends playing on another server of a multi-server site show as offline.
//
// Who may see what: friendship comes from the API (/users/@me, using the
// caller's own token), never from the request, and a status answer only ever
// names the caller's friends and invites addressed to the caller.

// How long an invite stays on the friend's screen.
export const INVITE_TTL_MS = 5 * 60_000;
// Invites one player may have outstanding at once, across every lobby.
const MAX_INVITES_PER_SENDER = 20;

/**
 * Invites sent from this worker's lobbies. Kept in memory: an invite is only
 * worth anything while its lobby is open, and a lobby lives on one worker.
 */
export class FriendInvites {
  private invites: SocialInvite[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  add(invite: Omit<SocialInvite, "id" | "expiresAt">): SocialInvite {
    this.prune();
    // One live invite per (sender, recipient, lobby): a repeat click
    // refreshes it rather than stacking duplicates.
    this.invites = this.invites.filter(
      (i) =>
        !(
          i.fromPublicId === invite.fromPublicId &&
          i.toPublicId === invite.toPublicId &&
          i.gameID === invite.gameID
        ),
    );
    const fromSender = this.invites.filter(
      (i) => i.fromPublicId === invite.fromPublicId,
    );
    if (fromSender.length >= MAX_INVITES_PER_SENDER) {
      const oldest = fromSender[0];
      this.invites = this.invites.filter((i) => i !== oldest);
    }
    const full: SocialInvite = {
      ...invite,
      id: generateID(),
      expiresAt: this.now() + INVITE_TTL_MS,
    };
    this.invites.push(full);
    return full;
  }

  /** Live invites, dropping expired ones and any whose lobby has closed. */
  live(lobbyIsOpen: (gameID: string) => boolean): SocialInvite[] {
    this.prune();
    this.invites = this.invites.filter((i) => lobbyIsOpen(i.gameID));
    return [...this.invites];
  }

  private prune(): void {
    const now = this.now();
    this.invites = this.invites.filter((i) => i.expiresAt > now);
  }
}

/**
 * This worker's half of the social view: where each signed-in player is, and
 * the invites sent from its lobbies.
 *
 * Only private games are joinable from a friend's status: a private lobby
 * before it starts, or — once a private game is under way or over — the
 * group's next lobby if the server has opened one. Public games show as "in
 * a game" with nothing to join (public FFA is deliberately not joinable as a
 * group, see presenceLobbyId).
 */
export function buildSocialReport(
  gm: GameManager,
  invites: FriendInvites,
): SocialReport {
  const presence: SocialEntry[] = [];
  // allGames is optional-called like the per-game reads in
  // WorkerLobbyService: some tests hand that service a partial manager.
  for (const game of gm.allGames?.() ?? []) {
    const phase = game.phase();
    if (phase === GamePhase.Finished) continue;
    const inLobby = phase === GamePhase.Lobby && !game.hasStarted();
    const isPrivate = !game.isPublic();
    let joinGameID: string | undefined;
    if (isPrivate && inLobby) {
      joinGameID = game.id;
    } else if (isPrivate) {
      const next = game.successorLobby();
      if (next !== null && gm.game(next)?.phase() === GamePhase.Lobby) {
        joinGameID = next;
      }
    }
    for (const client of game.activeClients()) {
      if (client.publicId === undefined) continue;
      presence.push({
        publicId: client.publicId,
        gameID: game.id,
        state: inLobby ? "lobby" : "in_game",
        joinGameID,
        host: game.isCreator(client.persistentID) || undefined,
        workerPath:
          joinGameID === undefined
            ? undefined
            : ServerEnv.workerPath(joinGameID),
      });
    }
  }
  return {
    presence,
    invites: invites.live((gameID) => {
      const game = gm.game(gameID);
      return game !== null && game.phase() === GamePhase.Lobby;
    }),
  };
}

/** Merge per-worker reports into one view (the master's broadcast). */
export function mergeSocialReports(reports: SocialReport[]): SocialReport {
  return {
    presence: reports.flatMap((r) => r.presence),
    invites: reports.flatMap((r) => r.invites),
  };
}

// A player connected to several games at once (a lobby tab and a finished
// game's tab) is shown by the most useful one: a joinable lobby first, then
// any lobby, then a game.
function rank(entry: SocialEntry): number {
  if (entry.joinGameID !== undefined) return 0;
  return entry.state === "lobby" ? 1 : 2;
}

/**
 * What the caller may see: the status of each of their friends who is
 * playing on this server, and the invites addressed to them that are still
 * live. Friends who are not in any game are simply absent (offline, or on the
 * homepage — the server cannot tell those apart).
 */
export function friendStatusFor(
  myPublicId: string,
  friends: readonly string[],
  view: SocialReport,
  now: number = Date.now(),
): FriendStatusResponse {
  const friendSet = new Set(friends);
  const best = new Map<string, SocialEntry>();
  for (const entry of view.presence) {
    if (!friendSet.has(entry.publicId)) continue;
    const current = best.get(entry.publicId);
    if (current === undefined || rank(entry) < rank(current)) {
      best.set(entry.publicId, entry);
    }
  }
  const friendsOut: FriendPresenceEntry[] = [...best.values()].map((e) => ({
    publicId: e.publicId,
    state: e.state,
    joinGameID: e.joinGameID,
    host: e.host,
  }));
  const seen = new Set<string>();
  const invites: FriendInvite[] = [];
  for (const i of view.invites) {
    // Invites come only from friends; one unfriended since is dropped.
    if (i.toPublicId !== myPublicId || !friendSet.has(i.fromPublicId)) {
      continue;
    }
    if (i.expiresAt <= now || seen.has(i.id)) continue;
    seen.add(i.id);
    invites.push({
      id: i.id,
      fromPublicId: i.fromPublicId,
      fromName: i.fromName,
      gameID: i.gameID,
      expiresAt: i.expiresAt,
    });
  }
  return { friends: friendsOut, invites };
}

// /users/@me answers per token, briefly cached: the Friends page polls, and
// a fresh API round-trip per poll per player would hammer the API for a
// friends list that rarely changes.
const USER_CACHE_MS = 30_000;
type CachedIdentity = {
  publicId: string;
  friends: string[];
  username: string;
  at: number;
};
const identityCache = new Map<string, CachedIdentity>();

async function callerIdentity(
  authHeader: string | undefined,
): Promise<CachedIdentity | "unauthorized" | "no_account" | "error"> {
  if (!authHeader?.startsWith("Bearer ")) return "unauthorized";
  const token = authHeader.substring("Bearer ".length);
  const cached = identityCache.get(token);
  if (cached !== undefined && Date.now() - cached.at < USER_CACHE_MS) {
    return cached;
  }
  const auth = await verifyClientToken(token);
  if (auth.type !== "success") return "unauthorized";
  if (auth.claims === null) return "no_account";
  const me = await getUserMe(token);
  if (me.type === "error") {
    return me.status === 401 || me.status === 403 ? "unauthorized" : "error";
  }
  const player = me.response.player;
  const identity: CachedIdentity = {
    publicId: player.publicId,
    friends: player.friends,
    username: player.username ?? player.publicId,
    at: Date.now(),
  };
  if (identityCache.size > 10_000) identityCache.clear();
  identityCache.set(token, identity);
  return identity;
}

const InviteBodySchema = z.object({ publicId: z.string().min(1).max(64) });

export function registerFriendRoutes(opts: {
  app: express.Express;
  gm: GameManager;
  invites: FriendInvites;
  // The merged cluster view (master broadcast) with this worker's own
  // fresher report laid over it.
  socialView: () => SocialReport;
  log: typeof logger;
}) {
  const { app, gm, invites, socialView, log } = opts;

  const statusLimiter = rateLimit({ windowMs: 10_000, max: 10 });
  app.get("/api/friends/status", statusLimiter, async (req, res) => {
    const me = await callerIdentity(req.headers.authorization);
    if (me === "unauthorized") return res.status(401).json({ error: "auth" });
    if (me === "no_account") {
      return res.json({
        friends: [],
        invites: [],
      } satisfies FriendStatusResponse);
    }
    if (me === "error") return res.status(502).json({ error: "api" });
    res.json(friendStatusFor(me.publicId, me.friends, socialView()));
  });

  const inviteLimiter = rateLimit({ windowMs: 60_000, max: 30 });
  app.post("/api/game/:id/invite", inviteLimiter, async (req, res) => {
    const gameId = ID.safeParse(req.params.id);
    const body = InviteBodySchema.safeParse(req.body);
    if (!gameId.success || !body.success) {
      return res.status(400).json({ error: "bad_request" });
    }
    const me = await callerIdentity(req.headers.authorization);
    if (me === "unauthorized" || me === "no_account") {
      return res.status(401).json({ error: "auth" });
    }
    if (me === "error") return res.status(502).json({ error: "api" });

    const game = gm.game(gameId.data);
    if (game === null || game.phase() !== GamePhase.Lobby) {
      return res.status(404).json({ error: "not_found" });
    }
    if (game.isPublic()) {
      return res.status(403).json({ error: "public" });
    }
    // The sender must be in the lobby they are inviting to, and the
    // recipient must be their friend (per the API, not the request).
    const sender = game.activeClients().find((c) => c.publicId === me.publicId);
    if (sender === undefined) {
      return res.status(403).json({ error: "not_in_lobby" });
    }
    if (!me.friends.includes(body.data.publicId)) {
      return res.status(403).json({ error: "not_friend" });
    }
    invites.add({
      toPublicId: body.data.publicId,
      fromPublicId: me.publicId,
      fromName: sender.username,
      gameID: game.id,
      workerPath: ServerEnv.workerPath(game.id),
    });
    log.info("friend invited to lobby", { gameID: game.id });
    res.status(204).end();
  });
}
