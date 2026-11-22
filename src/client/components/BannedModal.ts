import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import { html, LitElement } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { getCurrentLanguage, translateText } from "../Utils";
import "./baseComponents/Modal";
import type { OModal } from "./baseComponents/Modal";

type Ban = NonNullable<NonNullable<UserMeResponse["ban"]>>;

/**
 * Shows a banned player *why* they're banned. The game server already refuses a
 * banned account's WebSocket ("Account Banned"); this surfaces the rich reason
 * the API returns on GET /users/@me (`ban`) — a localized category, the
 * moderator's player-facing reason, and when the ban lifts (or that it's
 * permanent).
 *
 * Reads the `userMeResponse` document event (dispatched after login / on load),
 * like <marketing-consent-toast>. It opens the modal once; if the player closes
 * it, it stays closed for the session (they still can't play — the server
 * enforces that — but they aren't trapped behind the dialog).
 */
@customElement("banned-modal")
export class BannedModal extends LitElement {
  @state() private ban: Ban | null = null;
  @query("o-modal") private modalEl?: OModal;
  private opened = false;

  private onUserMeResponse = (event: Event) => {
    const detail = (event as CustomEvent<UserMeResponse | false>).detail;
    // No ban (or @me failed) clears the notice — e.g. an unban that lands in
    // the same session — and re-arms `opened` so a later re-ban reopens it.
    if (detail === false || !detail.ban) {
      this.ban = null;
      this.opened = false;
      return;
    }
    this.ban = detail.ban;
  };

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("userMeResponse", this.onUserMeResponse);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("userMeResponse", this.onUserMeResponse);
  }

  updated() {
    // Open once. The `open` guard keeps this resilient where <o-modal> isn't
    // registered (unit tests) and stops a re-open after the player closes it.
    if (this.ban && !this.opened && typeof this.modalEl?.open === "function") {
      this.opened = true;
      this.modalEl.open();
    }
  }

  // Map the server category to its label, falling back to the generic ToS
  // wording for a value a newer server introduced that this client can't name.
  private categoryLabel(category: string): string {
    const key = `ban_notice.category.${category}`;
    const label = translateText(key);
    return label === key ? translateText("ban_notice.category.other") : label;
  }

  private detailRow(label: string, value: string) {
    return html`
      <div class="px-4 py-3">
        <dt class="text-xs font-bold uppercase tracking-wider text-white/50">
          ${label}
        </dt>
        <dd class="mt-1 text-sm text-white wrap-anywhere">${value}</dd>
      </div>
    `;
  }

  render() {
    const ban = this.ban;
    if (!ban) return html``;
    return html`
      <o-modal hideHeader fitContent maxWidth="28rem">
        <div class="flex flex-col gap-5 p-6">
          <div class="flex items-center gap-4 pr-6">
            <div
              class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-red-500/30 bg-red-500/15 text-red-400"
            >
              <svg
                class="h-6 w-6"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M5.6 5.6l12.8 12.8" />
              </svg>
            </div>
            <div class="min-w-0">
              <h2 class="text-xl font-bold leading-tight text-white">
                ${translateText("ban_notice.title")}
              </h2>
              <p class="mt-1 text-sm font-medium text-red-300">
                ${this.categoryLabel(ban.category)}
              </p>
            </div>
          </div>
          <dl
            class="divide-y divide-white/10 rounded-xl border border-white/10 bg-white/5"
          >
            ${
              ban.reason
                ? this.detailRow(
                    translateText("ban_notice.reason_label"),
                    ban.reason,
                  )
                : null
            }
            ${this.detailRow(
              translateText("ban_notice.expires_label"),
              ban.expiresAt
                ? new Date(ban.expiresAt).toLocaleString(
                    [getCurrentLanguage(), "en"],
                    {
                      dateStyle: "long",
                      timeStyle: "short",
                    },
                  )
                : translateText("ban_notice.expires_never"),
            )}
          </dl>
        </div>
      </o-modal>
    `;
  }
}
