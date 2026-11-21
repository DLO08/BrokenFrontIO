import { ID } from "@openfront/engine-api/Schemas";
import { z } from "zod";

// GET /wN/api/friends/status on a game server: where the caller's friends are
// playing (on that server) and the lobby invites waiting for the caller. See
// src/server/FriendPresence.ts.

export const FriendPresenceEntrySchema = z.object({
  publicId: z.string(),
  state: z.enum(["lobby", "in_game"]),
  // A lobby the caller can join to play with this friend: their private
  // lobby, or the next lobby of the private game they are in.
  joinGameID: ID.optional(),
  host: z.boolean().optional(),
});
export type FriendPresenceEntry = z.infer<typeof FriendPresenceEntrySchema>;

export const FriendInviteSchema = z.object({
  id: z.string(),
  fromPublicId: z.string(),
  // The sender's in-lobby name, as the server screened it.
  fromName: z.string(),
  gameID: ID,
  expiresAt: z.number(),
});
export type FriendInvite = z.infer<typeof FriendInviteSchema>;

export const FriendStatusResponseSchema = z.object({
  friends: z.array(FriendPresenceEntrySchema),
  invites: z.array(FriendInviteSchema),
});
export type FriendStatusResponse = z.infer<typeof FriendStatusResponseSchema>;
