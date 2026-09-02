/**
 * Apps widget styles, scoped by the shadow root.
 *
 * A string rather than a `.css` file so the widget carries its own styles into
 * its shadow DOM without depending on the build pipeline injecting them — a
 * shadow root does not see the document's stylesheet, which is the point of
 * using one.
 *
 * ## Custom properties DO cross the shadow boundary
 *
 * That is why this works at all: `--haven-*` inherits through the shadow root
 * even though rules do not, so the widget follows the shell's theme.
 *
 * ## Why the fallbacks are gone
 *
 * Every colour used to be written `var(--haven-surface, #202124)` — a DARK
 * fallback. When the shell's theme was light and a token happened to be
 * undefined, the widget took the dark fallback for a background while its text
 * followed the real light theme, and the sort control rendered near-black on
 * near-black. The tokens are all defined in `main.css` now, in both themes, so
 * a fallback can only ever fire when the design is already broken — at which
 * point it does not rescue the widget, it hides the breakage. They are removed
 * deliberately: if a token goes missing, this should look obviously wrong
 * rather than subtly wrong.
 */
export const STYLES = `
  :host {
    display: block;
    container-type: inline-size;
    color: var(--haven-fg);
    font-family: var(--haven-font, system-ui, -apple-system, 'Segoe UI', sans-serif);
  }

  .apps {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    height: 100%;
    min-height: 0;
  }

  /* ── Controls ─────────────────────────────────────────────────────── */

  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--haven-space-2, 8px);
  }

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--haven-space-2, 8px);
  }

  /* Real pills with counts, matching the dashboard this replaces. 36px tall
     rather than the 22px they were — a pill you cannot hit is a decoration. */
  .tab {
    min-height: 36px;
    padding: var(--haven-space-2, 8px) var(--haven-space-4, 16px);
    border: 1px solid var(--haven-border);
    border-radius: var(--haven-radius-pill, 999px);
    background: var(--haven-surface);
    color: var(--haven-fg-secondary);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
  }

  .tab:hover {
    border-color: var(--haven-accent);
    background: var(--haven-surface-hover);
    color: var(--haven-fg);
  }

  .tab:focus-visible {
    outline: 2px solid var(--haven-accent);
    outline-offset: 2px;
  }

  /* The selected tab is filled amber. "aria-selected" already carries this for
     assistive tech; the fill carries it visually, and the weight change means
     it is not colour alone. */
  .tab--active {
    border-color: var(--haven-accent);
    background: var(--haven-accent);
    color: var(--haven-accent-fg);
    font-weight: 600;
  }

  .tab--active:hover {
    background: var(--haven-accent-hover);
    color: var(--haven-accent-fg);
  }

  .sort {
    display: inline-flex;
    align-items: center;
    gap: var(--haven-space-2, 8px);
    color: var(--haven-fg-secondary);
    font-size: 12px;
  }

  .sort__select {
    min-height: 36px;
    padding: var(--haven-space-2, 8px) var(--haven-space-3, 12px);
    border: 1px solid var(--haven-border);
    border-radius: var(--haven-radius-sm, 8px);
    /* Both halves come from the same theme, deliberately. Taking the text via
       color:inherit while the background came from a dark fallback rendered
       this near-black on near-black in a light theme. */
    background: var(--haven-surface);
    color: var(--haven-fg);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .sort__select:hover {
    border-color: var(--haven-accent);
  }

  .sort__select:focus-visible {
    outline: 2px solid var(--haven-accent);
    outline-offset: 2px;
  }

  /* ── Card grid ────────────────────────────────────────────────────── */

  .grid {
    display: grid;
    /* auto-fill + minmax is what makes this responsive without a media query:
       the grid becomes a single column on a phone on its own. */
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 11rem), 1fr));
    gap: var(--haven-space-3, 12px);
    overflow-y: auto;
    min-height: 0;
    padding: 2px;
  }

  /* Below the mobile breakpoint, two columns rather than one: these cards are
     square-ish and centred, so a single column of them wastes most of a phone
     screen on whitespace. */
  @container (max-width: 26rem) {
    .grid {
      grid-template-columns: repeat(2, 1fr);
      gap: var(--haven-space-2, 8px);
    }
  }

  /* The card.
   *
   * Centred, icon above name, matching the dashboard this replaces. The old
   * layout was a left-aligned text row with a small icon beside it, which read
   * as a list item rather than a tile you press.
   *
   * "position: relative" because the status dot is positioned into the corner
   * rather than sitting in the text flow. */
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    /* A minimum height so a card with a menu and one without are the same
       size. Without it the grid rows are ragged: a card whose app has no
       secondary URLs and no known version renders no kebab (.menu:empty)
       and comes out ~28px shorter than its neighbours. */
    min-height: 9.5rem;
    gap: var(--haven-space-2, 8px);
    padding: var(--haven-space-5, 20px) var(--haven-space-3, 12px);
    border: 1px solid var(--haven-border);
    border-radius: var(--haven-radius, 12px);
    background: var(--haven-surface);
    text-align: center;
    transition:
      transform 140ms ease,
      border-color 140ms ease,
      background 140ms ease,
      box-shadow 140ms ease;
  }

  /* The hover lift. Applied to the CARD on hover-within, so hovering anywhere
     on the tile responds — not just the link text. */
  .card:hover,
  .card:focus-within {
    transform: translateY(-2px);
    border-color: var(--haven-accent);
    background: var(--haven-surface-hover);
    box-shadow: var(--haven-shadow-lg, 0 10px 15px -3px rgb(0 0 0 / 40%));
  }

  /* Transform-based motion is the kind that causes trouble for people who ask
     for less of it. The colour change stays; only the movement goes. */
  @media (prefers-reduced-motion: reduce) {
    .card {
      transition: border-color 140ms ease, background 140ms ease;
    }

    .card:hover,
    .card:focus-within {
      transform: none;
    }
  }

  .card__head {
    display: contents;
  }

  .card__icon {
    width: 44px;
    height: 44px;
    flex: 0 0 auto;
    object-fit: contain;
    border-radius: var(--haven-radius-sm, 8px);
  }

  .card__titles {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    width: 100%;
  }

  .card__name {
    display: block;
    color: var(--haven-fg);
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    overflow-wrap: anywhere;
  }

  /* The whole card is the click target, not just the six characters of the
     name. A stretched link keeps ONE anchor — so the accessible name, the
     keyboard tab stop and the context menu are all still the link's — while
     making the hit area the full tile, which is what gets it past 44x44. */
  .card__name::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
  }

  .card__name:hover,
  .card__name:focus-visible {
    color: var(--haven-accent);
  }

  .card__name:focus-visible {
    outline: none;
  }

  /* The ring goes on the CARD, because the link's own box is just the text —
     an outline there would draw a thin rectangle around the name instead of
     around the thing that looks focused. */
  .card:focus-within {
    outline: 2px solid var(--haven-accent);
    outline-offset: 2px;
  }

  .card__description {
    margin: 0;
    color: var(--haven-fg-secondary);
    font-size: 11px;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  /* ── Status dot ───────────────────────────────────────────────────── */

  /* Colour is a redundant cue only. The meaning is carried by title,
     aria-label and the visually-hidden text inside the dot — and, since the
     dot now sits in the card corner where there is no adjacent text, by SHAPE
     as well: reachable is a filled disc, unreachable is a ring, unknown is a
     smaller muted disc. Colour is never the only carrier.
   *
   * "z-index: 1" puts it above ".card__name::after", the stretched link
   * overlay. Without it the dot is underneath a transparent anchor and its
   * "title" tooltip never appears — the overlay eats the pointer. */
  .dot {
    position: absolute;
    top: var(--haven-space-2, 8px);
    right: var(--haven-space-2, 8px);
    z-index: 1;
    flex: 0 0 auto;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--haven-unknown);
  }

  .dot--reachable {
    background: var(--haven-ok);
  }

  /* A RING rather than a disc: unreachable is distinguishable from reachable
     without perceiving the red/green difference. */
  .dot--unreachable {
    background: transparent;
    border: 2px solid var(--haven-bad);
  }

  .dot--checking {
    background: var(--haven-warn);
    animation: haven-pulse 1.2s ease-in-out infinite;
  }

  .dot--unknown {
    width: 8px;
    height: 8px;
    margin: 1px;
    background: var(--haven-unknown);
  }

  @keyframes haven-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  @media (prefers-reduced-motion: reduce) {
    .dot--checking {
      animation: none;
    }
  }

  /* ── Version pair ─────────────────────────────────────────────────── */

  .versions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: var(--haven-space-1, 4px);
    font-size: 10px;
  }

  .version {
    display: inline-flex;
    align-items: baseline;
    gap: var(--haven-space-1, 4px);
    padding: 2px var(--haven-space-2, 8px);
    border: 1px solid var(--haven-border);
    border-radius: var(--haven-radius-sm, 8px);
    color: var(--haven-fg-secondary);
    font-variant-numeric: tabular-nums;
  }

  .version__tag {
    color: var(--haven-muted);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* The difference between the two is the whole point of the feature, so it
     gets a colour AND a text badge rather than colour alone. */
  .versions--update .version--latest {
    border-color: var(--haven-warn);
    color: var(--haven-warn);
  }

  .badge {
    padding: 2px var(--haven-space-2, 8px);
    border-radius: var(--haven-radius-pill, 999px);
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .badge--update {
    background: var(--haven-warn);
    color: var(--haven-accent-fg);
  }

  /* How old the running-version reading is. Quiet by default — it is context,
     not an alert — until it is old enough to be untrustworthy, at which point
     it is the most important thing in the row. */
  .version__age {
    color: var(--haven-muted);
    font-size: 9px;
    font-variant-numeric: tabular-nums;
  }

  .version__age--stale {
    color: var(--haven-warn);
  }

  /* ── The kebab menu ───────────────────────────────────────────────── */

  /* Bottom-right of the card, on the same row as the description — matching
     the dashboard this replaces, whose ".app-card-menu-row" is exactly this
     pairing.

     "z-index: 1" puts it above the stretched card link
     (".card__name::after"), or the button cannot be clicked at all: the
     overlay covers the whole card including this button. */
  .menu {
    position: relative;
    z-index: 1;
    display: flex;
    justify-content: flex-end;
    width: 100%;
    margin-top: auto;
  }

  /* An empty menu container must occupy nothing. A card with no secondaries
     and no known version renders the container with no children, and without
     this the flex box still claims a row of height on every such card. */
  .menu:empty {
    display: none;
  }

  /* 28px is the smallest this can be and still be a real touch target beside
     the 44px card icon; the glyph inside is 14px. */
  .menu__toggle {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--haven-radius-sm, 8px);
    background: transparent;
    color: var(--haven-fg-secondary);
    font: inherit;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }

  .menu__toggle:hover,
  .menu__toggle:focus-visible {
    border-color: var(--haven-accent);
    background: var(--haven-surface-hover);
    color: var(--haven-fg);
  }

  .menu__toggle:focus-visible {
    outline: 2px solid var(--haven-accent);
    outline-offset: 1px;
  }

  /* The open menu is a POPOVER anchored to the card's bottom-right, not a
     block that pushes the card taller. An inline list re-flowed the whole
     grid every time one card's menu opened, shoving every card after it down
     the page — which is the behaviour that makes an inline disclosure feel
     broken on a grid. */
  .menu__list {
    position: absolute;
    top: calc(100% + var(--haven-space-1, 4px));
    right: 0;
    z-index: 2;
    min-width: 11rem;
    max-width: 16rem;
    list-style: none;
    margin: 0;
    padding: var(--haven-space-1, 4px);
    border: 1px solid var(--haven-border);
    border-radius: var(--haven-radius-sm, 8px);
    background: var(--haven-bg-elevated);
    box-shadow: var(--haven-shadow-lg, 0 10px 15px -3px rgb(0 0 0 / 40%));
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
  }

  /* A closed menu is closed.
   *
   * The widget marks the collapsed list with the "hidden" ATTRIBUTE, which the
   * UA stylesheet implements as "display: none" — at UA specificity, which any
   * author "display" declaration beats. So the rule above silently re-showed
   * every collapsed menu, and each card rendered its secondary URLs unprompted
   * under a toggle that claimed to be collapsed. A browser caught this; the
   * unit tests could not, because they assert on the "hidden" property and it
   * was correctly true the whole time.
   *
   * The trap is UNCHANGED by the move to a popover — ".menu__list" still
   * declares "display: flex", so this override is still the only thing
   * keeping a closed menu closed. Deleting it reopens the exact same bug. */
  .menu__list[hidden] {
    display: none;
  }

  .menu__item {
    display: block;
    padding: var(--haven-space-2, 8px);
    border-radius: var(--haven-radius-sm, 8px);
    color: var(--haven-fg-secondary);
    font-size: 11px;
    text-decoration: none;
    overflow-wrap: anywhere;
  }

  .menu__item:hover,
  .menu__item:focus-visible {
    background: var(--haven-surface-hover);
    color: var(--haven-accent);
  }

  /* The version pair sits inside the menu now, so it is laid out left-aligned
     with the items above it rather than centred as a card-face chip row. */
  .menu__versions-row {
    padding: var(--haven-space-2, 8px);
    border-top: 1px solid var(--haven-border);
    margin-top: var(--haven-space-1, 4px);
  }

  .menu__versions-row .versions {
    justify-content: flex-start;
  }

  .empty {
    grid-column: 1 / -1;
    margin: 0;
    padding: var(--haven-space-8, 32px);
    color: var(--haven-fg-secondary);
    font-size: 13px;
    text-align: center;
  }

  /* Available to screen readers, invisible on screen — this is what stops
     colour from being the only carrier of the dot's meaning. */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
`;

export default { STYLES };
