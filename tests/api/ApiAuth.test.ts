import {
  TokenPayloadSchema,
  UserMeResponseSchema,
} from "@openfront/shared/ApiSchemas";
import { base64urlToUuid } from "@openfront/shared/Base64";
import { JwksSchema } from "@openfront/shared/configuration/Env";
import { importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";

import { jwksBody, loadSigningKey } from "../../services/api/src/auth/keys";
import { issueAccessToken } from "../../services/api/src/auth/tokens";
import { loadConfig } from "../../services/api/src/config";
import type { Db } from "../../services/api/src/db/pool";
import { userMeBody } from "../../services/api/src/routes/users";

/**
 * Enough of a Db for key loading: the first SELECT finds nothing, the INSERT
 * succeeds, so loadSigningKey takes its generate-and-store path. Nothing here
 * needs Postgres, which keeps the contract tests runnable in CI.
 */
function fakeDb(): Db {
  return {
    async query(text: string) {
      const rows = text.trimStart().startsWith("SELECT") ? [] : [];
      return {
        rows,
        rowCount: text.trimStart().startsWith("INSERT") ? 1 : 0,
      } as never;
    },
    async tx(fn) {
      return fn(fakeDb());
    },
    async close() {},
  };
}

const BASE_ENV = {
  DATABASE_URL: "postgres://localhost/test",
  NODE_ENV: "test",
} as NodeJS.ProcessEnv;

describe("API config", () => {
  it("derives the issuer the game server will look for", () => {
    // ServerEnv.jwtIssuer(): "localhost" -> http://localhost:<port>.
    expect(loadConfig({ ...BASE_ENV, JWT_AUDIENCE: "localhost" }).issuer).toBe(
      "http://localhost:8787",
    );
    expect(
      loadConfig({ ...BASE_ENV, JWT_AUDIENCE: "example.com" }).issuer,
    ).toBe("https://api.example.com");
  });

  it("honours an explicit issuer override", () => {
    const config = loadConfig({
      ...BASE_ENV,
      JWT_AUDIENCE: "example.com",
      JWT_ISSUER: "https://tunnel.example.net",
    });
    expect(config.issuer).toBe("https://tunnel.example.net");
  });

  it("refuses to start in production without an API key", () => {
    expect(() => loadConfig({ ...BASE_ENV, NODE_ENV: "production" })).toThrow(
      /API_KEY is required/,
    );
  });
});

describe("signing key", () => {
  it("publishes a JWKS the game server accepts", async () => {
    const key = await loadSigningKey(fakeDb());
    // ServerEnv.jwkPublicKey() parses the body with exactly this schema and
    // then uses keys[0], so a shape change here breaks every join.
    const parsed = JwksSchema.safeParse(jwksBody(key));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.keys[0].kty).toBe("OKP");
    expect(parsed.data?.keys[0].crv).toBe("Ed25519");
  });
});

describe("access token", () => {
  it("verifies against the published JWKS and parses as a TokenPayload", async () => {
    const config = loadConfig({ ...BASE_ENV, JWT_AUDIENCE: "example.com" });
    const key = await loadSigningKey(fakeDb());
    const id = "123e4567-e89b-12d3-a456-426614174000";

    const token = await issueAccessToken(
      config,
      key,
      { id, role: null },
      "guest",
    );

    // Verify the way src/server/jwt.ts does: the public JWK from our own
    // JWKS, EdDSA only, issuer and audience pinned.
    const published = JwksSchema.parse(jwksBody(key)).keys[0];
    const publicKey = await importJWK(published, "EdDSA");
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ["EdDSA"],
      issuer: config.issuer,
      audience: config.audience,
    });

    const claims = TokenPayloadSchema.parse(payload);
    // TokenPayloadSchema transforms `sub` from base64url back to the UUID;
    // that UUID is the persistentID the game server keys the socket on.
    expect(claims.sub).toBe(id);
    expect(claims.iss).toBe("https://api.example.com");
    expect(claims.aud).toBe("example.com");
    expect(claims.role).toBeUndefined();
  });

  it("carries a role when the account has one", async () => {
    const config = loadConfig(BASE_ENV);
    const key = await loadSigningKey(fakeDb());
    const token = await issueAccessToken(
      config,
      key,
      { id: "123e4567-e89b-12d3-a456-426614174000", role: "admin" },
      "google",
    );
    const publicKey = await importJWK(jwksBody(key).keys[0], "EdDSA");
    const { payload } = await jwtVerify(token, publicKey);
    expect(TokenPayloadSchema.parse(payload).role).toBe("admin");
  });

  it("encodes sub as base64url, not a raw UUID", async () => {
    const config = loadConfig(BASE_ENV);
    const key = await loadSigningKey(fakeDb());
    const id = "123e4567-e89b-12d3-a456-426614174000";
    const token = await issueAccessToken(
      config,
      key,
      { id, role: null },
      "guest",
    );
    const raw = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    expect(raw.sub).not.toBe(id);
    expect(base64urlToUuid(raw.sub)).toBe(id);
  });
});

describe("/users/@me", () => {
  it("satisfies UserMeResponseSchema", () => {
    const body = userMeBody(
      {
        id: "123e4567-e89b-12d3-a456-426614174000",
        publicId: "HabCsQYR",
        role: null,
        adfree: false,
        levelHidden: false,
        searchHidden: false,
      },
      { noticesSeen: ["welcome"] },
    );
    const parsed = UserMeResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.player.publicId).toBe("HabCsQYR");
    expect(parsed.data?.player.subscription).toBeNull();
  });

  it("leaves unimplemented features absent rather than faking them", () => {
    // The client reads "absent" as "this deployment has no progression /
    // currency" and hides the UI. Sending zeroes would render level 1, 0 XP.
    const body = userMeBody(
      {
        id: "123e4567-e89b-12d3-a456-426614174000",
        publicId: "HabCsQYR",
        role: null,
        adfree: false,
        levelHidden: false,
        searchHidden: false,
      },
      { noticesSeen: [] },
    );
    expect(body.player.progress).toBeUndefined();
    expect(body.player.currency).toBeUndefined();
  });
});
