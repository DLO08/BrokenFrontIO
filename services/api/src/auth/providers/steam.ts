/**
 * Steam sign-in, by two different doors.
 *
 *  - The desktop shell holds a session ticket from the running Steam client
 *    and posts it to /auth/steam. We hand it to Steam's Web API, which tells
 *    us which SteamID it belongs to.
 *  - The website has no Steam client, so it bounces the browser through
 *    Steam's OpenID 2.0 provider and verifies the response that comes back.
 *
 * Both end at a SteamID we are willing to call authenticated. Neither trusts
 * anything the caller said about who they are.
 */

export type SteamIdentity = {
  steamId: string;
  personaName: string | null;
  avatarUrl: string | null;
};

export type SteamAuthResult =
  | { ok: true; identity: SteamIdentity }
  | { ok: false; reason: "rejected" | "unavailable" };

export type SteamConfig = { apiKey: string; appId: number | null };

type Fetch = typeof fetch;

const WEB_API = "https://api.steampowered.com";
export const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";

/**
 * Desktop path: AuthenticateUserTicket.
 *
 * A 200 from Steam does NOT mean success -- Steam reports ticket problems as
 * a `response.error` object inside a 200 body, so the error branch has to be
 * checked explicitly or every bad ticket would read as a valid login.
 */
export async function authenticateSteamTicket(
  ticket: string,
  config: SteamConfig,
  doFetch: Fetch = fetch,
): Promise<SteamAuthResult> {
  if (config.appId === null) return { ok: false, reason: "unavailable" };
  const url = new URL(`${WEB_API}/ISteamUserAuth/AuthenticateUserTicket/v1/`);
  url.searchParams.set("key", config.apiKey);
  url.searchParams.set("appid", String(config.appId));
  url.searchParams.set("ticket", ticket);

  let body: unknown;
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, reason: "unavailable" };
    body = await res.json();
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  const params = (body as { response?: Record<string, unknown> } | null)
    ?.response;
  if (params === undefined || params === null) {
    return { ok: false, reason: "unavailable" };
  }
  if ("error" in params) return { ok: false, reason: "rejected" };

  const steamId = (params.params as { steamid?: unknown } | undefined)?.steamid;
  if (typeof steamId !== "string" || !/^\d{17}$/.test(steamId)) {
    return { ok: false, reason: "rejected" };
  }
  return { ok: true, identity: await withProfile(steamId, config, doFetch) };
}

/** The URL the browser is sent to for the website's Steam sign-in. */
export function steamOpenIdRedirect(returnTo: string, realm: string): string {
  const url = new URL(STEAM_OPENID_ENDPOINT);
  url.searchParams.set("openid.ns", "http://specs.openid.net/auth/2.0");
  url.searchParams.set("openid.mode", "checkid_setup");
  url.searchParams.set("openid.return_to", returnTo);
  url.searchParams.set("openid.realm", realm);
  url.searchParams.set(
    "openid.identity",
    "http://specs.openid.net/auth/2.0/identifier_select",
  );
  url.searchParams.set(
    "openid.claimed_id",
    "http://specs.openid.net/auth/2.0/identifier_select",
  );
  return url.toString();
}

const CLAIMED_ID = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

/**
 * Website path: hand Steam's own response back to Steam with
 * `openid.mode=check_authentication` and believe only its verdict.
 *
 * The query string arrives from the user's browser, so every field in it is
 * attacker-controlled -- including `openid.claimed_id`. Parsing the SteamID
 * out of it before Steam confirms the signature would let anyone sign in as
 * any SteamID by editing a URL, which is the classic way this gets broken.
 */
export async function verifySteamOpenId(
  query: Record<string, string | string[] | undefined>,
  config: SteamConfig,
  doFetch: Fetch = fetch,
): Promise<SteamAuthResult> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith("openid.")) continue;
    const one = Array.isArray(value) ? value[0] : value;
    if (typeof one === "string") form.set(key, one);
  }
  form.set("openid.mode", "check_authentication");

  let text: string;
  try {
    const res = await doFetch(STEAM_OPENID_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, reason: "unavailable" };
    text = await res.text();
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  if (!/is_valid\s*:\s*true/.test(text)) {
    return { ok: false, reason: "rejected" };
  }

  // Only now is claimed_id worth reading.
  const claimed = form.get("openid.claimed_id") ?? "";
  const match = CLAIMED_ID.exec(claimed);
  if (match === null) return { ok: false, reason: "rejected" };

  return { ok: true, identity: await withProfile(match[1], config, doFetch) };
}

/**
 * Decorates a verified SteamID with its public persona. Best-effort: the
 * identity is already established, so a profile lookup failing must not fail
 * the sign-in -- it just means no display name yet.
 */
async function withProfile(
  steamId: string,
  config: SteamConfig,
  doFetch: Fetch,
): Promise<SteamIdentity> {
  try {
    const url = new URL(`${WEB_API}/ISteamUser/GetPlayerSummaries/v2/`);
    url.searchParams.set("key", config.apiKey);
    url.searchParams.set("steamids", steamId);
    const res = await doFetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return bare(steamId);
    const body = (await res.json()) as {
      response?: {
        players?: { personaname?: unknown; avatarfull?: unknown }[];
      };
    };
    const player = body.response?.players?.[0];
    return {
      steamId,
      personaName:
        typeof player?.personaname === "string" ? player.personaname : null,
      avatarUrl:
        typeof player?.avatarfull === "string" ? player.avatarfull : null,
    };
  } catch {
    return bare(steamId);
  }
}

function bare(steamId: string): SteamIdentity {
  return { steamId, personaName: null, avatarUrl: null };
}
