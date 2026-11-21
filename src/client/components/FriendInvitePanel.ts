import type { FriendEntry } from "@openfront/shared/ApiSchemas";
import type { FriendPresenceEntry } from "@openfront/shared/FriendSchemas";
import { html, LitElement, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  fetchAllFriends,
  fetchFriendStatus,
  inviteFriendToLobby,
} from "../FriendsApi";
import { showToast, translateText } from "../Utils";

// Refresh of who is where while the panel is open.
const POLL_MS = 10_000;

/**
 * "Invite friends" for a private lobby: every friend on the account, with an
 * Invite button, or "In this lobby" once they have joined. Renders nothing
 * for a signed-out player (no friends to list).
 */
@customElement("friend-invite-panel")
export class FriendInvitePanel extends LitElement {
  @property({ type: String }) gameID = "";

  @state() private friends: FriendEntry[] | null = null;
  @state() private presence = new Map<string, FriendPresenceEntry>();
  @state() private invited = new Set<string>();
  @state() private open = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
    this.timer = setInterval(() => void this.refreshPresence(), POLL_MS);
  }

  disconnectedCallback(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    super.disconnectedCallback();
  }

  protected willUpdate(changed: PropertyValues): void {
    // A different lobby: invites sent to the old one do not count here.
    if (changed.has("gameID") && changed.get("gameID") !== undefined) {
      this.invited = new Set();
    }
  }

  private async load(): Promise<void> {
    const friends = await fetchAllFriends();
    this.friends = friends === false ? [] : friends;
    await this.refreshPresence();
  }

  private async refreshPresence(): Promise<void> {
    if (this.friends === null || this.friends.length === 0) return;
    const status = await fetchFriendStatus();
    if (status === false) return;
    this.presence = new Map(status.friends.map((f) => [f.publicId, f]));
  }

  private inThisLobby(publicId: string): boolean {
    const p = this.presence.get(publicId);
    return p?.state === "lobby" && p.joinGameID === this.gameID;
  }

  private async invite(friend: FriendEntry): Promise<void> {
    if (this.gameID === "") return;
    const result = await inviteFriendToLobby(this.gameID, friend.publicId);
    if (result === true) {
      this.invited = new Set([...this.invited, friend.publicId]);
      showToast(
        translateText("friend_invite.sent", {
          name: friend.username ?? friend.publicId,
        }),
        "green",
      );
      return;
    }
    showToast(
      translateText(
        result === "not_friend"
          ? "friend_invite.not_friend"
          : "friend_invite.failed",
      ),
      "red",
    );
  }

  render() {
    if (this.friends === null || this.friends.length === 0) return nothing;
    // Friends already here last; the rest by name.
    const sorted = [...this.friends].sort((a, b) => {
      const here =
        Number(this.inThisLobby(a.publicId)) -
        Number(this.inThisLobby(b.publicId));
      if (here !== 0) return here;
      return (a.username ?? a.publicId).localeCompare(b.username ?? b.publicId);
    });
    return html`
      <div class="rounded-xl border border-white/10 bg-white/5">
        <button
          type="button"
          class="w-full flex items-center justify-between gap-2 px-4 py-3 text-left text-white font-bold text-sm uppercase tracking-wider"
          aria-expanded=${this.open}
          @click=${() => (this.open = !this.open)}
        >
          <span>
            ${translateText("friend_invite.title")}
            <span class="text-white/40 font-medium normal-case"
              >(${this.friends.length})</span
            >
          </span>
          <span aria-hidden="true">${this.open ? "▴" : "▾"}</span>
        </button>
        ${
          this.open
            ? html`<div
                class="px-4 pb-4 flex flex-col gap-2 max-h-64 overflow-y-auto"
              >
                ${sorted.map((f) => this.renderRow(f))}
              </div>`
            : nothing
        }
      </div>
    `;
  }

  private renderRow(friend: FriendEntry) {
    const name = friend.username ?? friend.publicId;
    const here = this.inThisLobby(friend.publicId);
    const sent = this.invited.has(friend.publicId);
    const elsewhere = !here && this.presence.has(friend.publicId);
    return html`
      <div
        class="flex items-center gap-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2"
      >
        <span
          class="w-2 h-2 rounded-full shrink-0 ${
            here ? "bg-green-400" : elsewhere ? "bg-amber-400" : "bg-white/20"
          }"
          aria-hidden="true"
        ></span>
        <span class="flex-1 min-w-0 truncate text-sm text-white">${name}</span>
        ${
          here
            ? html`<span class="text-xs text-green-300 font-bold">
                ${translateText("friend_invite.in_lobby")}
              </span>`
            : html`<button
                type="button"
                ?disabled=${sent}
                @click=${() => void this.invite(friend)}
                class="px-3 py-1 text-xs font-bold uppercase tracking-wider rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:pointer-events-none"
              >
                ${
                  sent
                    ? translateText("friend_invite.invited")
                    : translateText("friend_invite.invite")
                }
              </button>`
        }
      </div>
    `;
  }
}
