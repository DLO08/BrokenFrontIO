import { assetUrl } from "@openfront/shared/AssetUrls";
import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { BaseModal, type ModalConfig } from "./components/BaseModal";
import { modalHeader } from "./components/ui/ModalHeader";
import { renderMarkdown } from "./Markdown";
import { modalRouter } from "./ModalRouter";
import { textDirection, translateText } from "./Utils";

/**
 * The feature wiki: one page per BrokenFront feature, written as markdown in
 * `resources/wiki/` and fetched like the changelog. The pages are part of the
 * game, so they ship with it and update with it — whenever a feature changes,
 * its page and the in-game tutorial step that teaches it change too.
 *
 * Pages link to each other with `#modal=wiki&page=<slug>` hrefs, which the
 * modal router picks up on hashchange and routes back here, so in-page links
 * and the browser's Back button both work without any handling here.
 */

/** A wiki page: its markdown file's basename and its nav label. */
interface WikiPage {
  slug: string;
  titleKey: string;
}

export const WIKI_PAGES: readonly WikiPage[] = [
  { slug: "index", titleKey: "wiki.page.index" },
  { slug: "uranium", titleKey: "wiki.page.uranium" },
  { slug: "nukes", titleKey: "wiki.page.nukes" },
  { slug: "air-war", titleKey: "wiki.page.air_war" },
  { slug: "sea-economy", titleKey: "wiki.page.sea_economy" },
  { slug: "trade", titleKey: "wiki.page.trade" },
  { slug: "allies", titleKey: "wiki.page.allies" },
  { slug: "maps", titleKey: "wiki.page.maps" },
];

const DEFAULT_PAGE = "index";

/** Markdown prose styling, shared with the news and help pages. */
const PROSE_CLASS = `prose prose-invert prose-sm max-w-none
  [&_a]:text-blue-400 [&_a:hover]:text-blue-300
  [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mb-4 [&_h1]:text-white [&_h1]:border-b [&_h1]:border-white/10 [&_h1]:pb-2
  [&_h2]:text-xl [&_h2]:font-bold [&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:text-blue-200
  [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-blue-100
  [&_ul]:ps-5 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1
  [&_li]:text-gray-300 [&_li]:leading-relaxed
  [&_p]:text-gray-300 [&_p]:mb-3 [&_strong]:text-white [&_strong]:font-bold
  [&_code]:text-cyber-yellow [&_pre]:bg-black/40 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto
  [&_table]:w-full [&_table]:my-4 [&_table]:border-collapse
  [&_thead]:bg-white/10
  [&_th]:py-2 [&_th]:px-3 [&_th]:text-start [&_th]:text-xs [&_th]:font-bold [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-blue-300
  [&_td]:py-2 [&_td]:px-3 [&_td]:border-b [&_td]:border-white/5 [&_td]:text-gray-300 [&_td]:align-top`;

@customElement("wiki-modal")
export class WikiModal extends BaseModal {
  protected routerName = "wiki";

  @state() private page = DEFAULT_PAGE;
  @state() private markdown: string | null = null;
  @state() private failed = false;

  /** Fetched pages, by slug — a page is never fetched twice per session. */
  private cache = new Map<string, string>();

  protected modalConfig(): ModalConfig {
    return { maxWidth: "1100px" };
  }

  protected renderHeaderSlot() {
    return modalHeader({
      title: translateText("wiki.title"),
      onBack: () => this.close(),
      ariaLabel: translateText("common.back"),
    });
  }

  protected onOpen(args?: Record<string, unknown>): void {
    const requested = typeof args?.page === "string" ? args.page : null;
    this.show(
      requested !== null && WIKI_PAGES.some((p) => p.slug === requested)
        ? requested
        : DEFAULT_PAGE,
      // The router drives the URL when it opened us; don't write it back.
      false,
    );
  }

  /** Switches to `slug`, fetching it if this is the first visit. */
  private show(slug: string, writeUrl: boolean): void {
    this.page = slug;
    this.failed = false;
    const cached = this.cache.get(slug);
    this.markdown = cached ?? null;
    if (writeUrl) {
      modalRouter.syncArgs("wiki", { page: slug === DEFAULT_PAGE ? "" : slug });
    }
    this.modalEl?.syncScrollToTop();
    if (cached !== undefined) return;
    fetch(assetUrl(`wiki/${slug}.md`))
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((markdown) => {
        this.cache.set(slug, markdown);
        // A slow fetch can land after the reader has moved on.
        if (this.page === slug) this.markdown = markdown;
      })
      .catch((error) => {
        console.warn(`Failed to load wiki page ${slug}`, error);
        if (this.page === slug) this.failed = true;
      });
  }

  protected renderBody() {
    return html`
      <div
        dir=${textDirection()}
        class="flex flex-col md:flex-row gap-4 px-4 py-3 md:px-6"
      >
        <nav
          class="shrink-0 md:w-56 flex md:flex-col gap-1 overflow-x-auto md:overflow-visible"
          aria-label=${translateText("wiki.title")}
        >
          ${WIKI_PAGES.map((p) => this.renderNavItem(p))}
        </nav>
        <article class="min-w-0 flex-1 ${PROSE_CLASS}">
          ${this.renderContent()}
        </article>
      </div>
    `;
  }

  private renderNavItem(p: WikiPage) {
    const active = p.slug === this.page;
    return html`<button
      class="shrink-0 text-start whitespace-nowrap md:whitespace-normal rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "bg-white/10 text-brand"
          : "text-white/70 hover:bg-white/5 hover:text-white"
      }"
      aria-current=${active ? "page" : nothing}
      @click=${() => this.show(p.slug, true)}
    >
      ${translateText(p.titleKey)}
    </button>`;
  }

  private renderContent() {
    if (this.failed) {
      return html`<p>${translateText("wiki.failed")}</p>`;
    }
    if (this.markdown === null) {
      return this.renderLoadingSpinner(translateText("wiki.loading"));
    }
    return renderMarkdown(this.markdown);
  }
}
