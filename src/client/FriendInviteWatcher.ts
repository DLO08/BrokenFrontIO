import type { FriendInvite } from "@openfront/shared/FriendSchemas";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { fetchFriendStatus, goToLobby } from "./FriendsApi";
import { filterName } from "./NameFilter";
import { translateText } from "./Utils";

// Watches for lobby invites from friends while a signed-in player is on the
// menu, and pops a small Join / Dismiss notice for each new one. The Friends
// page lists the same invites (and can dismiss them too).
//
// Polling, not a push channel: the menu has no socket to a game server, and an
// invite is only useful for a few minutes, so a ~15s delay is fine.

const POLL_MS = 15_000;
const DISMISSED_KEY = "friendInvites.dismissed";

/** Invite ids this player has dismissed (or already joined). */
export function dismissedInvites(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const ids: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch {
    return new Set();
  }
}

export function dismissInvite(id: string): void {
  try {
    // Invites expire within minutes; the newest 100 is plenty to remember.
    const ids = [...dismissedInvites(), id].slice(-100);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids));
  } catch {
    // Storage blocked: the notice just comes back on the next poll.
  }
}

@customElement("friend-invite-toast")
export class FriendInviteToast extends LitElement {
  @state() private invite: FriendInvite | null = null;
  private queue: FriendInvite[] = [];

  createRenderRoot() {
    return this;
  }

  /** Show these invites, ones not already shown or queued. */
  offer(invites: FriendInvite[]): void {
    const known = new Set([
      ...this.queue.map((i) => i.id),
      ...(this.invite ? [this.invite.id] : []),
    ]);
    for (const i of invites) if (!known.has(i.id)) this.queue.push(i);
    if (this.invite === null) this.next();
  }

  private next(): void {
    const dismissed = dismissedInvites();
    const now = Date.now();
    this.queue = this.queue.filter(
      (i) => !dismissed.has(i.id) && i.expiresAt > now,
    );
    this.invite = this.queue.shift() ?? null;
  }

  private dismiss(): void {
    if (this.invite !== null) dismissInvite(this.invite.id);
    this.next();
  }

  private join(): void {
    if (this.invite === null) return;
    dismissInvite(this.invite.id);
    goToLobby(this.invite.gameID);
  }

  render() {
    const invite = this.invite;
    if (invite === null) return nothing;
    return html`
      <div
        role="alert"
        class="fixed bottom-4 right-4 z-[10020] max-w-[min(90vw,360px)] bg-gray-900/95 border border-brand/50 text-white rounded-xl shadow-2xl backdrop-blur-md p-4 flex flex-col gap-3"
      >
        <div class="text-sm">
          ${translateText("friends_page.invite_from", {
            name: filterName(invite.fromName),
          })}
        </div>
        <div class="flex gap-2 justify-end">
          <button
            @click=${() => this.dismiss()}
            class="px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg bg-white/10 text-white/80 border border-white/10 hover:bg-white/20"
          >
            ${translateText("friends_page.dismiss")}
          </button>
          <button
            @click=${() => this.join()}
            class="px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg bg-green-600 text-white hover:bg-green-500"
          >
            ${translateText("friends_page.join")}
          </button>
        </div>
      </div>
    `;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start (signed in) or stop (signed out) watching for invites. Called on every
 * userMeResponse broadcast; repeat starts are no-ops.
 */
export function watchFriendInvites(signedIn: boolean): void {
  if (!signedIn) {
    if (timer !== null) clearInterval(timer);
    timer = null;
    return;
  }
  if (timer !== null) return;
  const poll = async () => {
    // Not mid-game (the in-game HUD is no place for it) and not in a
    // background tab.
    if (document.hidden || document.body.classList.contains("in-game")) {
      return;
    }
    const status = await fetchFriendStatus();
    if (status === false || status.invites.length === 0) return;
    let toast = document.querySelector("friend-invite-toast");
    if (!(toast instanceof FriendInviteToast)) {
      toast = document.createElement("friend-invite-toast");
      document.body.appendChild(toast);
    }
    (toast as FriendInviteToast).offer(status.invites);
  };
  void poll();
  timer = setInterval(() => void poll(), POLL_MS);
}
