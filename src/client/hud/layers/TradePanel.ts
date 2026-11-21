import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import { TradeView } from "@openfront/engine-api/game/GameUpdates";
import { renderNumber } from "@openfront/engine-lib/Format";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { BrokenfrontIntent, SendBrokenfrontIntentEvent } from "../../Transport";
import { translateText } from "../../Utils";
import { GameView, PlayerView } from "../../view";

const TARIFFS = [0, 10, 25] as const;

/**
 * BrokenFront international trade: the world uranium market, your tariff,
 * trade agreements and player-to-player resource offers. A collapsed tab on
 * the left edge of the screen opens it. Everything it shows comes from the
 * player's TradeView; every button sends one intent.
 */
@customElement("trade-panel")
export class TradePanel extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private open = false;
  @state() private trade: TradeView | undefined;
  @state() private partnerID = "";
  @state() private giveGold = 0;
  @state() private wantUranium = 0;
  @state() private giveUranium = 0;
  @state() private wantGold = 0;
  private lastTick = -1;
  @state() private featuresOn = { trade: false, uranium: false };

  createRenderRoot() {
    return this;
  }

  init() {}

  tick() {
    if (!this.game) return;
    // Ten refreshes a second at most; the view only changes on trade events.
    const t = this.game.ticks();
    if (t === this.lastTick) return;
    this.lastTick = t;
    const c = this.game.config();
    const trade = c.brokenfrontFeature("tradeDeals");
    const uranium = c.brokenfrontFeature("uranium");
    if (
      trade !== this.featuresOn.trade ||
      uranium !== this.featuresOn.uranium
    ) {
      this.featuresOn = { trade, uranium };
    }
    const me = this.game.myPlayer();
    const next = me?.trade();
    if (next !== this.trade) this.trade = next;
  }

  private enabled(): boolean {
    return this.featuresOn.trade || this.featuresOn.uranium;
  }

  private send(intent: BrokenfrontIntent) {
    this.eventBus.emit(new SendBrokenfrontIntentEvent(intent));
  }

  private name(id: string): string {
    try {
      return this.game.player(id).displayName();
    } catch {
      return id;
    }
  }

  private secondsLeft(tick: number): string {
    return `${Math.max(0, Math.ceil((tick - this.game.ticks()) / 10))}s`;
  }

  private tradePartners(): PlayerView[] {
    const me = this.game.myPlayer();
    if (!me) return [];
    return this.game
      .players()
      .filter(
        (p) => p.id() !== me.id() && p.isAlive() && p.type() !== PlayerType.Bot,
      )
      .sort((a, b) => a.displayName().localeCompare(b.displayName()));
  }

  render() {
    if (!this.game || !this.enabled() || !this.game.myPlayer()?.isAlive()) {
      return html``;
    }
    if (!this.open) {
      return html`<button
        class="fixed left-0 top-1/2 -translate-y-1/2 z-30 pointer-events-auto bg-gray-800/90 text-cyan-300 font-bold text-xs px-1.5 py-3 rounded-r-md border border-l-0 border-cyan-500 [writing-mode:vertical-rl]"
        @click=${() => (this.open = true)}
      >
        ${translateText("trade_panel.title")}
      </button>`;
    }
    const tv = this.trade;
    return html`<div
      class="fixed left-2 top-1/2 -translate-y-1/2 z-30 pointer-events-auto w-80 max-w-[calc(100vw-1rem)] max-h-[80vh] overflow-y-auto bg-gray-800/95 text-white text-sm rounded-lg shadow-lg border border-cyan-600 p-3 flex flex-col gap-3"
      @contextmenu=${(e: Event) => e.preventDefault()}
    >
      <div class="flex items-center justify-between">
        <span class="font-bold text-cyan-300"
          >${translateText("trade_panel.title")}</span
        >
        <button
          class="text-gray-400 hover:text-white"
          @click=${() => (this.open = false)}
        >
          ✕
        </button>
      </div>
      ${this.featuresOn.uranium ? this.renderMarket(tv) : ""}
      ${this.featuresOn.trade ? this.renderDiplomacy(tv) : ""}
    </div>`;
  }

  private renderMarket(tv: TradeView | undefined) {
    const price = tv?.marketPrice ?? 0;
    const btn =
      "px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 border border-gray-500";
    return html`<section class="flex flex-col gap-1">
      <span class="font-semibold text-lime-300"
        >${translateText("trade_panel.market")}</span
      >
      <span translate="no"
        >${translateText("trade_panel.market_price", {
          price: renderNumber(price),
        })}</span
      >
      <div class="flex gap-1 flex-wrap">
        ${[1, 10].map(
          (n) =>
            html`<button
                class=${btn}
                @click=${() => this.send({ type: "market_trade", side: "buy", amount: n })}
              >
                ${translateText("trade_panel.buy", { amount: n })}
              </button>
              <button
                class=${btn}
                @click=${() => this.send({ type: "market_trade", side: "sell", amount: n })}
              >
                ${translateText("trade_panel.sell", { amount: n })}
              </button>`,
        )}
      </div>
    </section>`;
  }

  private renderDiplomacy(tv: TradeView | undefined) {
    const btn =
      "px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 border border-gray-500";
    const offers = tv?.offers ?? [];
    const me = this.game.myPlayer()!;
    const incoming = offers.filter((o) => o.to === me.id());
    const outgoing = offers.filter((o) => o.from === me.id());
    const input =
      "w-20 bg-gray-900 border border-gray-600 rounded px-1 text-right";
    return html`
      <section class="flex flex-col gap-1">
        <span class="font-semibold text-cyan-300"
          >${translateText("trade_panel.tariff")}</span
        >
        <div class="flex gap-1">
          ${TARIFFS.map(
            (pct) =>
              html`<button
                class="${btn} ${tv?.tariffPct === pct ? "border-cyan-400 text-cyan-300" : ""}"
                @click=${() => this.send({ type: "set_tariff", pct })}
              >
                ${pct}%
              </button>`,
          )}
        </div>
      </section>

      <section class="flex flex-col gap-1">
        <span class="font-semibold text-cyan-300"
          >${translateText("trade_panel.agreements")}</span
        >
        ${(tv?.partners ?? []).map(
          (p) =>
            html`<div class="flex justify-between items-center">
              <span
                >${this.name(p.other)} · ${this.secondsLeft(p.expiresAt)}</span
              >
              <button
                class=${btn}
                @click=${() =>
                  this.send({
                    type: "trade_agreement",
                    action: "cancel",
                    other: p.other,
                  })}
              >
                ${translateText("trade_panel.cancel")}
              </button>
            </div>`,
        )}
        ${(tv?.incomingRequests ?? []).map(
          (id) =>
            html`<div class="flex justify-between items-center gap-1">
              <span
                >${translateText("trade_panel.request_from", { name: this.name(id) })}</span
              >
              <span class="flex gap-1">
                <button
                  class=${btn}
                  @click=${() =>
                    this.send({
                      type: "trade_agreement",
                      action: "accept",
                      other: id,
                    })}
                >
                  ✓
                </button>
                <button
                  class=${btn}
                  @click=${() =>
                    this.send({
                      type: "trade_agreement",
                      action: "reject",
                      other: id,
                    })}
                >
                  ✕
                </button>
              </span>
            </div>`,
        )}
        ${(tv?.outgoingRequests ?? []).map(
          (id) =>
            html`<span class="text-gray-400"
              >${translateText("trade_panel.request_to", { name: this.name(id) })}</span
            >`,
        )}
      </section>

      <section class="flex flex-col gap-1">
        <span class="font-semibold text-cyan-300"
          >${translateText("trade_panel.offers")}</span
        >
        ${incoming.map(
          (o) =>
            html`<div class="flex flex-col border border-gray-600 rounded p-1">
              <span
                >${translateText("trade_panel.offer_from", { name: this.name(o.from) })}
                (${this.secondsLeft(o.expiresAt)})</span
              >
              <span translate="no"
                >${translateText("trade_panel.offer_terms", {
                  giveGold: renderNumber(o.giveGold),
                  giveUranium: o.giveUranium,
                  wantGold: renderNumber(o.wantGold),
                  wantUranium: o.wantUranium,
                })}</span
              >
              <span class="flex gap-1">
                <button
                  class=${btn}
                  @click=${() =>
                    this.send({
                      type: "trade_offer_reply",
                      offerId: o.id,
                      accept: true,
                    })}
                >
                  ${translateText("trade_panel.accept")}
                </button>
                <button
                  class=${btn}
                  @click=${() =>
                    this.send({
                      type: "trade_offer_reply",
                      offerId: o.id,
                      accept: false,
                    })}
                >
                  ${translateText("trade_panel.decline")}
                </button>
              </span>
            </div>`,
        )}
        ${outgoing.map(
          (o) =>
            html`<span class="text-gray-400"
              >${translateText("trade_panel.offer_to", { name: this.name(o.to) })}
              (${this.secondsLeft(o.expiresAt)})</span
            >`,
        )}
      </section>

      <section class="flex flex-col gap-1">
        <span class="font-semibold text-cyan-300"
          >${translateText("trade_panel.new_deal")}</span
        >
        <select
          class="bg-gray-900 border border-gray-600 rounded px-1"
          .value=${this.partnerID}
          @change=${(e: Event) =>
            (this.partnerID = (e.target as HTMLSelectElement).value)}
        >
          <option value="">${translateText("trade_panel.pick_player")}</option>
          ${this.tradePartners().map(
            (p) => html`<option value=${p.id()}>${p.displayName()}</option>`,
          )}
        </select>
        <button
          class=${btn}
          ?disabled=${this.partnerID === ""}
          @click=${() =>
            this.send({
              type: "trade_agreement",
              action: "request",
              other: this.partnerID,
            })}
        >
          ${translateText("trade_panel.propose_agreement")}
        </button>
        <div class="grid grid-cols-2 gap-1 items-center" translate="no">
          <label>${translateText("trade_panel.give_gold")}</label>
          <input
            class=${input}
            type="number"
            min="0"
            .value=${String(this.giveGold)}
            @input=${(e: Event) => (this.giveGold = this.num(e))}
          />
          <label>${translateText("trade_panel.give_uranium")}</label>
          <input
            class=${input}
            type="number"
            min="0"
            .value=${String(this.giveUranium)}
            @input=${(e: Event) => (this.giveUranium = this.num(e))}
          />
          <label>${translateText("trade_panel.want_gold")}</label>
          <input
            class=${input}
            type="number"
            min="0"
            .value=${String(this.wantGold)}
            @input=${(e: Event) => (this.wantGold = this.num(e))}
          />
          <label>${translateText("trade_panel.want_uranium")}</label>
          <input
            class=${input}
            type="number"
            min="0"
            .value=${String(this.wantUranium)}
            @input=${(e: Event) => (this.wantUranium = this.num(e))}
          />
        </div>
        <button
          class=${btn}
          ?disabled=${this.partnerID === ""}
          @click=${() =>
            this.send({
              type: "trade_offer",
              recipient: this.partnerID,
              giveGold: this.giveGold,
              giveUranium: this.giveUranium,
              wantGold: this.wantGold,
              wantUranium: this.wantUranium,
            })}
        >
          ${translateText("trade_panel.send_offer")}
        </button>
      </section>
    `;
  }

  private num(e: Event): number {
    const v = Math.floor(Number((e.target as HTMLInputElement).value));
    return Number.isFinite(v) && v > 0 ? v : 0;
  }
}
