import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { exitGame, translateText } from "../../../client/Utils";
import { ClientEnv } from "../../ClientEnv";
import { Controller } from "../../Controller";
import { gamePortal } from "../../GamePortal";
import { NewLobbyEvent } from "../../Transport";
import { GameView } from "../../view";

// How long a finished game's players stay on the end screen before they are
// taken back to the group's lobby on their own.
export const RETURN_TO_LOBBY_SECONDS = 30;

// Emitted on the event bus when a lobby to return to is known, so the win
// screen can offer the same "Back to lobby" action as this banner.
export class NextLobbyKnownEvent {
  constructor(public readonly gameID: string) {}
}

/**
 * Take this player to the group's next lobby. The host goes back to the host
 * view (the ?host flag routes them there on load); everyone else joins.
 */
export async function goToNextLobby(
  gameID: string,
  asHost: boolean,
): Promise<void> {
  const url = `${window.location.origin}${ClientEnv.gamePath(gameID)}`;
  if (asHost) {
    window.location.href = `${url}?host`;
    return;
  }
  // On a portal the page URL still carries the invite param of the OLD
  // game, and it wins over the path on reload — navigating the iframe to our
  // own game URL would route the player straight back into the finished
  // lobby. Send the top page to a fresh portal invite link instead: it
  // updates that param and keeps the player on the portal. (The host is
  // unaffected: games they created are ignored by the invite-param check.)
  if (gamePortal.isOnGamePortal()) {
    const link = await gamePortal.createInviteLink(gameID);
    if (link !== null) {
      try {
        window.top!.location.href = link;
        return;
      } catch (error) {
        console.error("Portal: top navigation failed", error);
      }
    }
  }
  window.location.href = url;
}

// A private game's group stays together across games: when the game is
// decided the server opens the next lobby and tells everyone still here its
// id (NewLobbyEvent). Everyone — host included — gets this banner. Once the
// game is over it counts down and takes the player back to the lobby on its
// own; "Leave" is how a player chooses to stop playing with the group.
//
// The host can also open the next lobby mid-game (the sidebar's New lobby
// button); then there is no countdown, just the offer.
@customElement("new-lobby-prompt")
export class NewLobbyPrompt extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state()
  private isVisible = false;

  @state()
  private secondsLeft: number | null = null;

  private gameID: string | null = null;
  private countdown: ReturnType<typeof setInterval> | null = null;
  private navigating = false;

  // Override to prevent shadow DOM creation (so Tailwind classes apply).
  createRenderRoot() {
    return this;
  }

  init() {
    this.eventBus.on(NewLobbyEvent, (e) => this.onNewLobby(e));
  }

  tick() {
    // The successor usually arrives the moment the game is decided, but the
    // game-over update can land a beat later: start the countdown then.
    if (
      this.isVisible &&
      this.secondsLeft === null &&
      this.countdown === null &&
      this.game?.gameOver()
    ) {
      this.startCountdown();
    }
  }

  private isHost(): boolean {
    return this.game?.myPlayer()?.isLobbyCreator() ?? false;
  }

  private onNewLobby(event: NewLobbyEvent) {
    // A second broadcast of the same lobby (the server re-sends for late
    // joiners) must not restart the countdown.
    const sameLobby = this.gameID === event.gameID;
    this.gameID = event.gameID;
    this.eventBus.emit(new NextLobbyKnownEvent(event.gameID));
    this.isVisible = true;
    if (!sameLobby && this.game?.gameOver()) {
      this.startCountdown();
    }
    this.requestUpdate();
  }

  private startCountdown() {
    this.stopCountdown();
    this.secondsLeft = RETURN_TO_LOBBY_SECONDS;
    this.countdown = setInterval(() => {
      if (this.secondsLeft === null) return;
      this.secondsLeft -= 1;
      if (this.secondsLeft <= 0) {
        this.stopCountdown();
        void this._handleJoin();
      }
    }, 1000);
  }

  private stopCountdown() {
    if (this.countdown !== null) {
      clearInterval(this.countdown);
      this.countdown = null;
    }
  }

  private async _handleJoin() {
    if (this.gameID === null || this.navigating) {
      return;
    }
    this.navigating = true;
    this.stopCountdown();
    await goToNextLobby(this.gameID, this.isHost());
  }

  private async _handleLeave() {
    this.stopCountdown();
    this.isVisible = false;
    this.requestUpdate();
    await gamePortal.gameplayStop();
    exitGame();
  }

  // Stay on this screen (keep spectating, read the stats) without leaving the
  // group: the banner stays, the countdown stops.
  private _handleStay() {
    this.stopCountdown();
    this.secondsLeft = null;
  }

  render() {
    if (!this.isVisible) {
      return html``;
    }
    const counting = this.secondsLeft !== null;
    return html`
      <div
        class="fixed top-4 left-1/2 -translate-x-1/2 z-[10011] flex flex-wrap items-center justify-center gap-3 bg-gray-800/90 text-white px-4 py-3 rounded-lg shadow-2xl backdrop-blur-xs max-w-[90%]"
        role="status"
      >
        <span>
          ${
            counting
              ? translateText("new_lobby_prompt.returning", {
                  seconds: this.secondsLeft ?? 0,
                })
              : translateText("new_lobby_prompt.message")
          }
        </span>
        <o-button
          variant="primary"
          translationKey="new_lobby_prompt.join"
          @click=${this._handleJoin}
        ></o-button>
        ${
          counting
            ? html`<o-button
                variant="secondary"
                translationKey="new_lobby_prompt.stay"
                @click=${this._handleStay}
              ></o-button>`
            : null
        }
        <o-button
          variant="secondary"
          translationKey="new_lobby_prompt.leave"
          @click=${this._handleLeave}
        ></o-button>
      </div>
    `;
  }
}
