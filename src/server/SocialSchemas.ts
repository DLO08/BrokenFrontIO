import { ID } from "@openfront/engine-api/Schemas";
import { z } from "zod";

// The friend presence / invite data workers report to the master and the
// master broadcasts back (see FriendPresence.ts). Kept apart from it so the
// IPC schema, which the master imports, stays free of game-server code.

export const SocialEntrySchema = z.object({
  publicId: z.string(),
  gameID: ID,
  state: z.enum(["lobby", "in_game"]),
  joinGameID: ID.optional(),
  host: z.boolean().optional(),
  workerPath: z.string().optional(),
});
export type SocialEntry = z.infer<typeof SocialEntrySchema>;

export const SocialInviteSchema = z.object({
  id: z.string(),
  toPublicId: z.string(),
  fromPublicId: z.string(),
  fromName: z.string(),
  gameID: ID,
  workerPath: z.string(),
  expiresAt: z.number(),
});
export type SocialInvite = z.infer<typeof SocialInviteSchema>;

export const SocialReportSchema = z.object({
  presence: z.array(SocialEntrySchema),
  invites: z.array(SocialInviteSchema),
});
export type SocialReport = z.infer<typeof SocialReportSchema>;

export const EMPTY_SOCIAL: SocialReport = { presence: [], invites: [] };
