# The in-game wiki

The wiki is a page of the site, not a separate one: `#modal=wiki` on the
homepage, reachable from the **Wiki** nav item and from a card in the help
modal. One page per feature, describing what it does and the numbers behind it.

## Where it lives

| Part | File |
| --- | --- |
| Page content | `resources/wiki/<slug>.md` |
| The modal, and the list of pages | `src/client/WikiModal.ts` (`WIKI_PAGES`) |
| Nav labels and modal chrome | `resources/lang/en.json` under `wiki.*` |
| Page element | `index.html` (`<wiki-modal id="page-wiki">`) |
| Lazy chunk / router entry | `src/client/LazyModals.ts`, `src/client/Main.ts` |
| Production serving | `src/server/PublicAssetManifest.ts` (`wiki/**/*`) |
| Nav items | `src/client/components/{Desktop,Mobile}NavBar.ts` |

The markdown is fetched with `assetUrl("wiki/<slug>.md")` and rendered through
`renderMarkdown` (marked + DOMPurify), the same way the changelog is. Each page
is fetched once per session and cached in the modal.

Page content is English only, as the changelog is; everything else the modal
draws goes through `translateText()`.

## Adding or renaming a page

1. Write `resources/wiki/<slug>.md`.
2. Add `{ slug, titleKey }` to `WIKI_PAGES` in `src/client/WikiModal.ts`, in
   the order it should appear in the nav.
3. Add `wiki.page.<key>` to `resources/lang/en.json` (keys stay sorted).

`tests/client/WikiModal.test.ts` fails if a listed page has no markdown file,
so a typo in a slug is caught by the suite.

Pages link to each other with ordinary markdown links to
`#modal=wiki&page=<slug>`. The modal router picks those up on `hashchange`, so
in-page links and the browser's Back button both work with no extra handling.

## Keeping the wiki and the tutorial in step

**Whenever a gameplay feature is added, removed or rebalanced, update both the
wiki page that describes it and the in-game tutorial step that teaches it, in
the same change.**

The tutorial is `TUTORIAL_STEPS` in `src/client/hud/Tutorial.ts`, with its text
in `resources/lang/en.json` under `tutorial.step.*` (and `tutorial.step_touch.*`
for steps whose desktop wording leans on hotkeys or the hotbar). Steps carry an
`applies(ctx)` predicate, so a step for an optional feature is skipped in games
that have it off — a new feature's step needs its flag in `TutorialContext` and
in `TutorialPanel.buildContext`, and adding one means updating
`tests/Tutorial.test.ts`.

The third place the same facts live is the help modal
(`src/client/HelpModal.ts`): the build-menu table and the radial-menu list. A
new buildable or radial action belongs there too.

So, for a gameplay change, the checklist is:

- [ ] `resources/wiki/<feature>.md` — what it does and its numbers
- [ ] `TUTORIAL_STEPS` + `tutorial.step.*` — how a new player meets it
- [ ] `HelpModal` build/radial tables + `help_modal.*` — the reference entry
- [ ] `tests/Tutorial.test.ts` if the step list changed
