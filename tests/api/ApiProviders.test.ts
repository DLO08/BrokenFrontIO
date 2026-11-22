import { UserMeResponseSchema } from "@openfront/shared/ApiSchemas";
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { describe, expect, it } from "vitest";

import { verifyGoogleIdToken } from "../../services/api/src/auth/providers/google";
import { resolveRedirectOrigin } from "../../services/api/src/auth/providers/magiclink";
import {
  authenticateSteamTicket,
  verifySteamOpenId,
} from "../../services/api/src/auth/providers/steam";
import { userMeBody } from "../../services/api/src/routes/users";

const CLIENT_ID = "1234.apps.googleusercontent.com";

async function googleToken(
  claims: Record<string, unknown>,
  overrides: { audience?: string; issuer?: string } = {},
) {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? "https://accounts.google.com")
    .setAudience(overrides.audience ?? CLIENT_ID)
    .setExpirationTime("5m")
    .sign(privateKey);
  const jwks: JWTVerifyGetKey = async () => publicKey as CryptoKey;
  return { token, jwks };
}

describe("google id tokens", () => {
  it("accepts a well-formed token", async () => {
    const { token, jwks } = await googleToken({
      sub: "10987",
      email: "a@example.com",
      email_verified: true,
      name: "A Player",
    });
    const result = await verifyGoogleIdToken(token, CLIENT_ID, jwks);
    expect(result).toEqual({
      ok: true,
      identity: {
        subject: "10987",
        email: "a@example.com",
        emailVerified: true,
        name: "A Player",
      },
    });
  });

  it("rejects a token minted for another application", async () => {
    // The audience check is the whole boundary: an ID token for someone
    // else's Google app is still validly signed by Google.
    const { token, jwks } = await googleToken(
      { sub: "1", email: "a@example.com", email_verified: true },
      { audience: "someone-else.apps.googleusercontent.com" },
    );
    const result = await verifyGoogleIdToken(token, CLIENT_ID, jwks);
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects a token from the wrong issuer", async () => {
    const { token, jwks } = await googleToken(
      { sub: "1", email: "a@example.com", email_verified: true },
      { issuer: "https://evil.example" },
    );
    expect(await verifyGoogleIdToken(token, CLIENT_ID, jwks)).toEqual({
      ok: false,
      reason: "invalid_token",
    });
  });

  it("refuses an unverified email", async () => {
    // Otherwise someone could register a Google account carrying a victim's
    // address and use it to claim the victim's account by email.
    const { token, jwks } = await googleToken({
      sub: "1",
      email: "victim@example.com",
      email_verified: false,
    });
    expect(await verifyGoogleIdToken(token, CLIENT_ID, jwks)).toEqual({
      ok: false,
      reason: "email_unverified",
    });
  });
});

const STEAM = { apiKey: "key", appId: 1 };

function fetchReturning(body: string | object, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      async text() {
        return typeof body === "string" ? body : JSON.stringify(body);
      },
      async json() {
        return typeof body === "string" ? JSON.parse(body) : body;
      },
    }) as unknown as Response) as unknown as typeof fetch;
}

describe("steam openid", () => {
  const signedIn = {
    "openid.mode": "id_res",
    "openid.claimed_id":
      "https://steamcommunity.com/openid/id/76561190000000000",
    "openid.sig": "abc",
  };

  it("accepts a response Steam confirms", async () => {
    const result = await verifySteamOpenId(
      signedIn,
      STEAM,
      fetchReturning("ns:http://specs.openid.net/auth/2.0\nis_valid:true\n"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.identity.steamId).toBe("76561190000000000");
  });

  it("does NOT trust claimed_id when Steam says the response is invalid", async () => {
    // The query string comes from the user's browser, so claimed_id is
    // attacker-controlled. Reading the SteamID out of it before Steam
    // confirms the signature would let anyone sign in as anyone.
    const result = await verifySteamOpenId(
      signedIn,
      STEAM,
      fetchReturning("is_valid:false\n"),
    );
    expect(result).toEqual({ ok: false, reason: "rejected" });
  });

  it("rejects a confirmed response whose claimed_id is not a Steam id URL", async () => {
    const result = await verifySteamOpenId(
      { ...signedIn, "openid.claimed_id": "https://evil.example/id/123" },
      STEAM,
      fetchReturning("is_valid:true\n"),
    );
    expect(result).toEqual({ ok: false, reason: "rejected" });
  });

  it("reports Steam being down separately from a rejection", async () => {
    const result = await verifySteamOpenId(
      signedIn,
      STEAM,
      fetchReturning("", false),
    );
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("steam tickets", () => {
  it("accepts a ticket Steam resolves to a SteamID", async () => {
    const result = await authenticateSteamTicket(
      "t",
      STEAM,
      fetchReturning({
        response: { params: { steamid: "76561190000000001" } },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("treats an error inside a 200 as a rejection", async () => {
    // Steam reports ticket problems as `response.error` with HTTP 200, so
    // checking only the status code would accept every bad ticket.
    const result = await authenticateSteamTicket(
      "t",
      STEAM,
      fetchReturning({ response: { error: { errorcode: 3 } } }),
    );
    expect(result).toEqual({ ok: false, reason: "rejected" });
  });
});

describe("redirect allowlist", () => {
  const allowed = ["http://localhost:9000", "https://play.example.com/"];

  it("accepts an allowed origin regardless of trailing slash", () => {
    expect(resolveRedirectOrigin("https://play.example.com", allowed)).toBe(
      "https://play.example.com/",
    );
  });

  it("rejects a lookalike that merely starts with an allowed origin", () => {
    // The bug a startsWith() check would have.
    expect(
      resolveRedirectOrigin("https://play.example.com.evil.test", allowed),
    ).toBeNull();
  });

  it("rejects an unrelated origin and junk", () => {
    expect(resolveRedirectOrigin("https://evil.test", allowed)).toBeNull();
    expect(resolveRedirectOrigin("not a url", allowed)).toBeNull();
  });

  it("falls back to the first allowed origin when none is requested", () => {
    expect(resolveRedirectOrigin(undefined, allowed)).toBe(
      "http://localhost:9000",
    );
  });
});

describe("/users/@me with linked providers", () => {
  const user = {
    id: "123e4567-e89b-12d3-a456-426614174000",
    publicId: "HabCsQYR",
    role: null,
    adfree: false,
    levelHidden: false,
    searchHidden: false,
    email: "a@example.com",
  };

  it("reports linked google and steam, and still matches the schema", () => {
    const body = userMeBody(user, {
      noticesSeen: [],
      identities: [
        {
          provider: "google",
          subject: "1",
          email: "a@example.com",
          displayName: "A",
          profile: {},
        },
        {
          provider: "steam",
          subject: "76561190000000000",
          email: null,
          displayName: "Persona",
          profile: { avatarUrl: "https://img.example/a.jpg" },
        },
      ],
    });
    expect(UserMeResponseSchema.safeParse(body).success).toBe(true);
    expect(body.user.google).toEqual({ email: "a@example.com" });
    expect(body.user.steam?.steamId).toBe("76561190000000000");
    expect(body.user.steam?.personaName).toBe("Persona");
    expect(body.player.trustTier).toBe("trusted");
  });

  it("leaves a guest untrusted with no provider keys", () => {
    const body = userMeBody(
      { ...user, email: null },
      {
        noticesSeen: [],
        identities: [
          {
            provider: "guest",
            subject: "d",
            email: null,
            displayName: null,
            profile: {},
          },
        ],
      },
    );
    expect(UserMeResponseSchema.safeParse(body).success).toBe(true);
    expect(body.user.google).toBeUndefined();
    expect(body.user.steam).toBeUndefined();
    expect(body.user.email).toBeUndefined();
    expect(body.player.trustTier).toBe("untrusted");
  });
});
