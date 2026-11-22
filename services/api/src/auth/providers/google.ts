import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Verifying a Google ID token.
 *
 * The client does the whole OAuth dance itself (Google Identity Services) and
 * posts us only the resulting ID token, so all we do -- and all we must do --
 * is verify it. That verification is the entire security boundary: skip the
 * audience check and anyone could present an ID token minted for a different
 * application and sign in as that account's owner.
 */

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

export type GoogleIdentity = {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
};

export type GoogleVerifyResult =
  | { ok: true; identity: GoogleIdentity }
  | { ok: false; reason: "invalid_token" | "email_unverified" };

let cachedJwks: JWTVerifyGetKey | null = null;

/** Cached across calls: jose handles its own refresh and rate limiting. */
function defaultJwks(): JWTVerifyGetKey {
  cachedJwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return cachedJwks;
}

/**
 * `jwks` is injectable so tests can verify against a locally minted token
 * instead of reaching Google.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
  jwks: JWTVerifyGetKey = defaultJwks(),
): Promise<GoogleVerifyResult> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, jwks, {
      // Pinned: without it, a token could name its own algorithm and an
      // attacker gets to pick the weakest one the key material allows.
      algorithms: ["RS256"],
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
    }));
  } catch {
    return { ok: false, reason: "invalid_token" };
  }

  const subject = payload.sub;
  const email = payload.email;
  if (typeof subject !== "string" || typeof email !== "string") {
    return { ok: false, reason: "invalid_token" };
  }
  // Google will happily issue a token for an unverified address. Treating
  // that as proof of the address would let someone sign up with a Google
  // account bearing a victim's email and claim their account by email.
  if (payload.email_verified !== true) {
    return { ok: false, reason: "email_unverified" };
  }

  return {
    ok: true,
    identity: {
      subject,
      email,
      emailVerified: true,
      name: typeof payload.name === "string" ? payload.name : null,
    },
  };
}
