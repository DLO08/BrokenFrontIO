import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import { Router } from "express";
import { z } from "zod";

import { noticesSeen, type User } from "../accounts";
import { requireUser, type Ctx } from "../http/app";

/**
 * Builds the /users/@me body.
 *
 * UserMeResponseSchema is large but almost entirely optional, and the
 * optionality is load-bearing: the client is written so that an absent field
 * means "this deployment doesn't have the feature" and hides the UI, while a
 * malformed one can fail the whole parse and make the player look signed out.
 * So a field we do not serve yet is LEFT OUT rather than faked -- `progress`
 * absent hides the level UI, `currency` absent hides balances, and so on.
 *
 * Required, and therefore the real contract for stage 1:
 *   user                            (every member optional)
 *   player.publicId
 *   player.adfree
 *   player.canCreatePublicLobbies
 *   player.achievements.singleplayerMap
 *   player.friends
 *   player.subscription             (nullable, but must be present)
 */
export function userMeBody(
  user: User,
  extras: { noticesSeen: string[] },
): UserMeResponse {
  return {
    user: {},
    ban: null,
    steamLicence: false,
    steamLicenceSince: null,
    noticesSeen: extras.noticesSeen,
    pendingMessages: [],
    player: {
      publicId: user.publicId,
      adfree: user.adfree,
      // No monetisation yet, so nobody is entitled to list a public custom
      // lobby. Flipping this on is part of the subscriptions stage.
      canCreatePublicLobbies: false,
      // A guest with no linked provider is exactly what "untrusted" is for:
      // it gates ranked, and is not an accusation.
      trustTier: "untrusted",
      achievements: { singleplayerMap: [], player: [] },
      friends: [],
      subscription: null,
      levelHidden: user.levelHidden,
      searchHidden: user.searchHidden,
    },
  };
}

const VisibilitySchema = z.object({ hidden: z.boolean() });
const NoticeSchema = z.object({ key: z.string().min(1).max(128) });

export function userRoutes(ctx: Ctx) {
  const r = Router();
  const auth = requireUser(ctx);

  r.get("/@me", auth, async (req, res) => {
    const user = req.user!;
    res.json(
      userMeBody(user, { noticesSeen: await noticesSeen(ctx.db, user.id) }),
    );
  });

  r.post("/@me/notices", auth, async (req, res) => {
    const body = NoticeSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: z.prettifyError(body.error) });
      return;
    }
    await ctx.db.query(
      `INSERT INTO user_notices_seen (user_id, key) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.user!.id, body.data.key],
    );
    res.status(204).end();
  });

  for (const [path, column] of [
    ["/@me/level_visibility", "level_hidden"],
    ["/@me/search_visibility", "search_hidden"],
  ] as const) {
    r.put(path, auth, async (req, res) => {
      const body = VisibilitySchema.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: z.prettifyError(body.error) });
        return;
      }
      // `column` is from the literal list above, never from the request.
      await ctx.db.query(`UPDATE users SET ${column} = $1 WHERE id = $2`, [
        body.data.hidden,
        req.user!.id,
      ]);
      res.json({ hidden: body.data.hidden });
    });
  }

  return r;
}
