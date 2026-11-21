import type { FriendEntry } from "@openfront/shared/ApiSchemas";
import type {
  FriendInvite,
  FriendPresenceEntry,
} from "@openfront/shared/FriendSchemas";
import { html, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getUserMe } from "./Api";
import { BaseModal } from "./components/BaseModal";
import "./components/FriendsList";
import { modalHeader } from "./components/ui/ModalHeader";
import { playerNameLink } from "./components/ui/PlayerNameLink";
import { signedOutNotice } from "./components/ui/SignedOutNotice";
import { dismissInvite, dismissedInvites } from "./FriendInviteWatcher";
import { fetchAllFriends, fetchFriendStatus, goToLobby } from "./FriendsApi";
import { filterName } from "./NameFilter";
import { translateText } from "./Utils";

// How often the open page refreshes where friends are.
const POLL_MS = 10_000;

/**
 * The Friends page: lobby invites waiting for you, which friends are playing
 * right now (with a Join button when their lobby is open to you), and the
 * friend list itself (add, requests, remove — the same component as the
 * account page's Friends tab).
 */
@customElement("friends-modal")
export class FriendsModal extends BaseModal {
  protected routerName = "friends";

  @state() private signedIn: boolean | null = null;
  @state() private myPublicId = "";
  @state() private friends: FriendEntry[] = [];
  @state() private presence: FriendPresenceEntry[] = [];
  @state() private invites: FriendInvite[] = [];
  @state() private statusAvailable = true;

  private timer: ReturnType<typeof setInterval> | null = null;

  protected onOpen(): void {
    void this.load();
    this.timer = setInterval(() => void this.refreshStatus(), POLL_MS);
  }

  protected onClose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async load(): Promise<void> {
    const me = await getUserMe();
    this.signedIn = me !== false;
    if (me === false) return;
    this.myPublicId = me.player.publicId;
    const friends = await fetchAllFriends();
    if (friends) this.friends = friends;
    await this.refreshStatus();
  }

  private async refreshStatus(): Promise<void> {
    if (this.signedIn !== true) return;
    const status = await fetchFriendStatus();
    if (status === false) {
      this.statusAvailable = false;
      return;
    }
    this.statusAvailable = true;
    this.presence = status.friends;
    const dismissed = dismissedInvites();
    this.invites = status.invites.filter((i) => !dismissed.has(i.id));
  }

  private nameOf(publicId: string): string | undefined {
    return (
      this.friends.find((f) => f.publicId === publicId)?.username ?? undefined
    );
  }

  protected renderHeaderSlot() {
    return modalHeader({
      title: translateText("friends_page.title"),
      onBack: () => this.close(),
      ariaLabel: translateText("common.close"),
    });
  }

  protected renderBody(): TemplateResult {
    if (this.signedIn === null) {
      return html`<div class="flex items-center justify-center p-12">
        <div
          class="w-10 h-10 border-4 border-blue-500/30 border-t-blue-500 rounded-full animate-spin"
        ></div>
      </div>`;
    }
    if (!this.signedIn) {
      return signedOutNotice(() => {
        this.close();
        window.showPage?.("page-account");
      }, translateText("friends_page.sign_in"));
    }
    return html`
      <div class="flex flex-col gap-6 p-4 lg:p-6">
        ${this.renderInvites()} ${this.renderPlaying()}
        <friends-list .myPublicId=${this.myPublicId}></friends-list>
      </div>
    `;
  }

  private renderInvites(): TemplateResult | typeof nothing {
    if (this.invites.length === 0) return nothing;
    return html`
      <section
        class="bg-brand/10 rounded-xl border border-brand/40 p-6"
        aria-labelledby="friend-invites-heading"
      >
        <h3
          id="friend-invites-heading"
          class="text-lg font-bold text-white mb-4"
        >
          ${translateText("friends_page.invites")}
        </h3>
        <div class="space-y-2">
          ${this.invites.map(
            (i) => html`
              <div
                class="flex flex-wrap items-center gap-3 bg-white/5 rounded-lg border border-white/10 p-3"
              >
                <div class="flex-1 min-w-0 text-white text-sm">
                  ${translateText("friends_page.invite_from", {
                    name: filterName(i.fromName),
                  })}
                </div>
                <button
                  @click=${() => goToLobby(i.gameID)}
                  class="px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg bg-green-500/20 text-green-300 border border-green-500/30 hover:bg-green-500/30 transition-all"
                >
                  ${translateText("friends_page.join")}
                </button>
                <button
                  @click=${() => {
                    dismissInvite(i.id);
                    this.invites = this.invites.filter((x) => x.id !== i.id);
                  }}
                  class="px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg bg-white/10 text-white/70 border border-white/10 hover:bg-white/20 transition-all"
                >
                  ${translateText("friends_page.dismiss")}
                </button>
              </div>
            `,
          )}
        </div>
      </section>
    `;
  }

  private renderPlaying(): TemplateResult {
    // Joinable lobbies first, then other lobbies, then games in progress.
    const order = (p: FriendPresenceEntry) =>
      p.joinGameID !== undefined ? 0 : p.state === "lobby" ? 1 : 2;
    const playing = [...this.presence].sort((a, b) => order(a) - order(b));
    return html`
      <section class="bg-white/5 rounded-xl border border-white/10 p-6">
        <h3 class="text-lg font-bold text-white mb-1">
          ${translateText("friends_page.playing_now")}
        </h3>
        <p class="text-white/50 text-xs mb-4">
          ${translateText("friends_page.playing_now_hint")}
        </p>
        ${
          !this.statusAvailable
            ? html`<p class="text-white/60 text-sm">
                ${translateText("friends_page.status_unavailable")}
              </p>`
            : playing.length === 0
              ? html`<p class="text-white/60 text-sm">
                  ${translateText("friends_page.nobody_playing")}
                </p>`
              : html`<div class="space-y-2">
                  ${playing.map((p) => this.renderPlayingRow(p))}
                </div>`
        }
      </section>
    `;
  }

  private renderPlayingRow(p: FriendPresenceEntry): TemplateResult {
    const status =
      p.joinGameID !== undefined
        ? p.state === "lobby"
          ? p.host
            ? translateText("friends_page.status_hosting")
            : translateText("friends_page.status_in_lobby")
          : translateText("friends_page.status_next_lobby")
        : translateText("friends_page.status_in_game");
    return html`
      <div
        class="flex items-center gap-3 bg-white/5 rounded-lg border border-white/10 p-3"
      >
        <span
          class="w-2 h-2 rounded-full shrink-0 ${
            p.joinGameID !== undefined ? "bg-green-400" : "bg-amber-400"
          }"
          aria-hidden="true"
        ></span>
        <div class="flex-1 min-w-0">
          ${playerNameLink(this, this.nameOf(p.publicId), p.publicId)}
          <div class="text-white/50 text-[11px] mt-0.5">${status}</div>
        </div>
        ${
          p.joinGameID !== undefined
            ? html`<button
                @click=${() => goToLobby(p.joinGameID!)}
                class="px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg bg-green-500/20 text-green-300 border border-green-500/30 hover:bg-green-500/30 transition-all shrink-0"
              >
                ${translateText("friends_page.join")}
              </button>`
            : nothing
        }
      </div>
    `;
  }
}
