import { exportJWK, generateKeyPair, importJWK, type JWK } from "jose";

import type { Db } from "../db/pool";

/**
 * The signing key, as the rest of the service wants it.
 *
 * `publicJwk` is what /.well-known/jwks.json serves, and it must satisfy
 * JwksSchema in @openfront/shared/configuration/Env: alg EdDSA, crv Ed25519,
 * kty OKP, and an `x`. The game server reads keys[0] and caches it for the
 * life of the process (ServerEnv.jwkPublicKey), which is why rotating this
 * key needs a restart over there, and why we never quietly mint a second one.
 */
export type SigningKey = {
  kid: string;
  /** Signs access tokens. */
  privateKey: CryptoKey;
  /** Verifies them again on the way back in; jose rejects a private key here. */
  publicKey: CryptoKey;
  publicJwk: {
    kid: string;
    alg: "EdDSA";
    crv: "Ed25519";
    kty: "OKP";
    x: string;
  };
};

const ALG = "EdDSA";

function toPublicJwk(kid: string, jwk: JWK): SigningKey["publicJwk"] {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("signing key is not an Ed25519 OKP key");
  }
  return { kid, alg: ALG, kty: "OKP", crv: "Ed25519", x: jwk.x };
}

async function fromPrivateJwk(
  kid: string,
  privateJwk: JWK,
): Promise<SigningKey> {
  const privateKey = (await importJWK(privateJwk, ALG)) as CryptoKey;
  // The public half is the same key without the private scalar `d`. Rebuilt
  // field by field rather than spread-minus-d so nothing else the provider
  // stored can leak into what we publish.
  const publicPart: JWK = {
    kty: privateJwk.kty,
    crv: privateJwk.crv,
    x: privateJwk.x,
  };
  const publicKey = (await importJWK(publicPart, ALG)) as CryptoKey;
  return {
    kid,
    privateKey,
    publicKey,
    publicJwk: toPublicJwk(kid, publicPart),
  };
}

async function readActive(db: Db): Promise<SigningKey | null> {
  const r = await db.query<{ kid: string; private_jwk: JWK }>(
    "SELECT kid, private_jwk FROM signing_keys WHERE retired_at IS NULL LIMIT 1",
  );
  return r.rows.length > 0
    ? fromPrivateJwk(r.rows[0].kid, r.rows[0].private_jwk)
    : null;
}

/**
 * Loads the active signing key, generating one on first boot.
 *
 * The insert races safely: `signing_keys_one_active` is a unique partial
 * index, so if two instances start together exactly one wins and the loser
 * re-reads the winner's key rather than serving a JWKS nobody else agrees
 * with.
 */
export async function loadSigningKey(db: Db): Promise<SigningKey> {
  const existing = await readActive(db);
  if (existing !== null) return existing;

  const { privateKey, publicKey } = await generateKeyPair(ALG, {
    crv: "Ed25519",
    extractable: true,
  });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);
  const kid = crypto.randomUUID();

  const inserted = await db.query(
    `INSERT INTO signing_keys (kid, private_jwk, public_jwk)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [kid, privateJwk, { ...publicJwk, kid, alg: ALG }],
  );
  if (inserted.rowCount === 0) {
    const winner = await readActive(db);
    if (winner === null) {
      throw new Error("no active signing key after a conflicting insert");
    }
    return winner;
  }

  console.log(`[auth] generated signing key ${kid}`);
  return {
    kid,
    privateKey: privateKey as CryptoKey,
    publicKey: publicKey as CryptoKey,
    publicJwk: toPublicJwk(kid, publicJwk),
  };
}

/** The body of GET /.well-known/jwks.json. */
export function jwksBody(key: SigningKey) {
  return { keys: [key.publicJwk] };
}
