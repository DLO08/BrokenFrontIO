import {
  type FriendEntry,
  type FriendRequestsResponse,
  FriendRequestsResponseSchema,
  type FriendsListResponse,
  FriendsListResponseSchema,
  type SendFriendRequestResponse,
  SendFriendRequestResponseSchema,
} from "@openfront/shared/ApiSchemas";
import {
  type FriendStatusResponse,
  FriendStatusResponseSchema,
} from "@openfront/shared/FriendSchemas";
import { getApiBase } from "./Api";
import { getAuthHeader, getPlayToken } from "./Auth";
import { ClientEnv } from "./ClientEnv";

export const FRIEND_REQUESTS_UPDATED_EVENT = "friend-requests-updated";

/** Friend requests plus their place in {@link nextFriendRequestsSeq}'s order. */
export type FriendRequestsSnapshot = FriendRequestsResponse & { seq: number };

let friendRequestsSeq = 0;

/**
 * Snapshots are ordered by when their fetch started, or when a local edit
 * (accept, deny, withdraw) was made, not by when they were published: the
 * Friends tab and the nav poller fetch independently, so an older fetch can
 * resolve after a newer one. Take a seq before fetching and pass it to
 * {@link publishFriendRequests}; a local edit takes a fresh one as it publishes.
 */
export function nextFriendRequestsSeq(): number {
  return ++friendRequestsSeq;
}

/**
 * Keep every friend-request surface in the tab on the same server snapshot.
 * The account page and nav notification poller both fetch this resource, so
 * whichever one refreshes publishes the result for the other. Listeners keep
 * the highest seq they have seen, so publishing an older snapshot is harmless.
 */
export function publishFriendRequests(
  requests: FriendRequestsResponse,
  seq: number,
): void {
  document.dispatchEvent(
    new CustomEvent<FriendRequestsSnapshot>(FRIEND_REQUESTS_UPDATED_EVENT, {
      detail: { ...requests, seq },
    }),
  );
}

async function friendsFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${getApiBase()}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...options?.headers,
      Authorization: await getAuthHeader(),
    },
  });
}

export type FriendActionError =
  | "not_found"
  | "conflict"
  | "bad_request"
  | "request_failed";

export async function fetchFriendRequests(): Promise<
  FriendRequestsResponse | false
> {
  try {
    const res = await friendsFetch("/friends/requests");
    if (!res.ok) return false;
    const parsed = FriendRequestsResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("fetchFriendRequests: zod failed", parsed.error);
      return false;
    }
    return parsed.data;
  } catch (err) {
    console.warn("fetchFriendRequests: request failed", err);
    return false;
  }
}

export async function fetchFriends(
  page: number,
  limit: number,
): Promise<FriendsListResponse | false> {
  try {
    const url = new URL(`${getApiBase()}/friends`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(limit));
    const res = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        Authorization: await getAuthHeader(),
      },
    });
    if (!res.ok) return false;
    const parsed = FriendsListResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("fetchFriends: zod failed", parsed.error);
      return false;
    }
    return parsed.data;
  } catch (err) {
    console.warn("fetchFriends: request failed", err);
    return false;
  }
}

export async function sendFriendRequest(
  publicId: string,
): Promise<SendFriendRequestResponse | FriendActionError> {
  try {
    const res = await friendsFetch(
      `/friends/requests/${encodeURIComponent(publicId)}`,
      { method: "POST" },
    );
    if (res.status === 404) return "not_found";
    if (res.status === 409) return "conflict";
    if (res.status === 400) return "bad_request";
    if (!res.ok) return "request_failed";
    const parsed = SendFriendRequestResponseSchema.safeParse(await res.json());
    if (!parsed.success) return "request_failed";
    return parsed.data;
  } catch (err) {
    console.warn("sendFriendRequest: request failed", err);
    return "request_failed";
  }
}

export async function acceptFriendRequest(
  publicId: string,
): Promise<true | FriendActionError> {
  try {
    const res = await friendsFetch(
      `/friends/requests/${encodeURIComponent(publicId)}/accept`,
      { method: "POST" },
    );
    if (res.status === 404) return "not_found";
    if (!res.ok) return "request_failed";
    return true;
  } catch (err) {
    console.warn("acceptFriendRequest: request failed", err);
    return "request_failed";
  }
}

export async function deleteFriendRequest(
  publicId: string,
): Promise<true | FriendActionError> {
  try {
    const res = await friendsFetch(
      `/friends/requests/${encodeURIComponent(publicId)}`,
      { method: "DELETE" },
    );
    if (res.status === 404) return "not_found";
    if (!res.ok) return "request_failed";
    return true;
  } catch (err) {
    console.warn("deleteFriendRequest: request failed", err);
    return "request_failed";
  }
}

export async function removeFriend(
  publicId: string,
): Promise<true | FriendActionError> {
  try {
    const res = await friendsFetch(`/friends/${encodeURIComponent(publicId)}`, {
      method: "DELETE",
    });
    if (res.status === 404) return "not_found";
    if (!res.ok) return "request_failed";
    return true;
  } catch (err) {
    console.warn("removeFriend: request failed", err);
    return "request_failed";
  }
}

// --- Friend presence and lobby invites (this game server) ---
//
// These go to a game server rather than the API: only the game server knows
// who is in which lobby. Any worker answers status (they share the master's
// merged view, see src/server/FriendPresence.ts); an invite goes to the
// worker that owns the lobby.

/** Where friends are playing and the invites waiting for you, or false. */
export async function fetchFriendStatus(): Promise<
  FriendStatusResponse | false
> {
  try {
    const token = await getPlayToken();
    const res = await fetch(
      `${ClientEnv.serverHttpBase()}/w0/api/friends/status`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );
    if (!res.ok) return false;
    const parsed = FriendStatusResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : false;
  } catch (err) {
    // No game server known (a static page), offline, or signed out.
    console.warn("fetchFriendStatus: request failed", err);
    return false;
  }
}

export type InviteResult = true | "not_friend" | "not_found" | "failed";

/** Invite a friend (by publicId) to the private lobby you are in. */
export async function inviteFriendToLobby(
  gameID: string,
  publicId: string,
): Promise<InviteResult> {
  try {
    const token = await getPlayToken();
    const res = await fetch(
      `${ClientEnv.gameHttpBase(gameID)}/${ClientEnv.gameWorkerPath(gameID)}/api/game/${encodeURIComponent(gameID)}/invite`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ publicId }),
      },
    );
    if (res.ok) return true;
    if (res.status === 404) return "not_found";
    if (res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return body.error === "not_friend" ? "not_friend" : "failed";
    }
    return "failed";
  } catch (err) {
    console.warn("inviteFriendToLobby: request failed", err);
    return "failed";
  }
}

/**
 * Every friend's publicId and account name, for labelling status rows.
 * Walks the API's pages up to a sane cap.
 */
export async function fetchAllFriends(
  maxPages = 10,
): Promise<FriendEntry[] | false> {
  const all: FriendEntry[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await fetchFriends(page, 50);
    if (!data) return page === 1 ? false : all;
    all.push(...data.results);
    if (all.length >= data.total || data.results.length < 50) break;
  }
  return all;
}

/** Open a lobby by id: the page load joins it (or reopens the host view). */
export function goToLobby(gameID: string): void {
  window.location.href = `${window.location.origin}${ClientEnv.gamePath(gameID)}`;
}
