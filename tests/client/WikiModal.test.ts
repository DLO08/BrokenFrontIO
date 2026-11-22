import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The named import registers <wiki-modal> as a side effect; a type-only import
// would be elided and leave the element inert.
import { WIKI_PAGES, WikiModal } from "../../src/client/WikiModal";

const WIKI_DIR = path.join(__dirname, "..", "..", "resources", "wiki");

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fetch that answers every wiki page with its slug in the body. */
function stubWikiFetch() {
  const fetchMock = vi.fn(async (input: unknown) => ({
    ok: true,
    text: async () => `# page\n\nbody of ${String(input)}`,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function mount(): Promise<WikiModal> {
  const modal = document.createElement("wiki-modal") as WikiModal;
  document.body.appendChild(modal);
  await modal.updateComplete;
  return modal;
}

describe("WikiModal", () => {
  it("has a markdown file for every page it lists", () => {
    for (const page of WIKI_PAGES) {
      const file = path.join(WIKI_DIR, `${page.slug}.md`);
      expect(fs.existsSync(file), `${page.slug}.md is missing`).toBe(true);
      expect(fs.readFileSync(file, "utf8").trim().length).toBeGreaterThan(0);
    }
  });

  it("opens on the overview and renders it", async () => {
    const fetchMock = stubWikiFetch();
    const modal = await mount();

    modal.open();
    await vi.waitFor(async () => {
      await modal.updateComplete;
      expect(modal.textContent).toContain("body of");
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain("wiki/index.md");
  });

  it("opens the page named in the router args", async () => {
    const fetchMock = stubWikiFetch();
    const modal = await mount();

    modal.open({ page: "uranium" });
    await vi.waitFor(() =>
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("wiki/uranium.md"),
    );
  });

  it("falls back to the overview for an unknown page", async () => {
    const fetchMock = stubWikiFetch();
    const modal = await mount();

    modal.open({ page: "../secrets" });
    await vi.waitFor(() =>
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("wiki/index.md"),
    );
  });

  it("fetches each page once and switches between them from the nav", async () => {
    const fetchMock = stubWikiFetch();
    const modal = await mount();

    modal.open();
    // Wait for the page to be on screen, not just requested: a page is only
    // cached once its fetch has landed.
    await vi.waitFor(async () => {
      await modal.updateComplete;
      expect(modal.textContent).toContain("wiki/index.md");
    });

    const nav = modal.querySelectorAll<HTMLButtonElement>("nav button");
    expect(nav.length).toBe(WIKI_PAGES.length);
    nav[1].click();
    await vi.waitFor(async () => {
      await modal.updateComplete;
      expect(modal.textContent).toContain(`wiki/${WIKI_PAGES[1].slug}.md`);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      `wiki/${WIKI_PAGES[1].slug}.md`,
    );

    // Back to the overview: already cached, so no second fetch for it.
    nav[0].click();
    await modal.updateComplete;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a page that fails to load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 })),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const modal = await mount();

    modal.open();
    await vi.waitFor(async () => {
      await modal.updateComplete;
      expect(modal.textContent).toContain("wiki.failed");
    });
    warn.mockRestore();
  });
});
