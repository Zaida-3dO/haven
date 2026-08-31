/**
 * Apps widget styles, scoped by the shadow root.
 *
 * A string rather than a `.css` file so the widget carries its own styles into
 * its shadow DOM without depending on the build pipeline injecting them — a
 * shadow root does not see the document's stylesheet, which is the point of
 * using one.
 *
 * Colours come from custom properties with fallbacks, so the widget inherits
 * the shell's theme where one is set and still renders standalone in a test
 * page where none is.
 */
export const STYLES = `
  :host {
    display: block;
    container-type: inline-size;
    color: var(--haven-fg, #e8eaed);
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
    gap: 0.5rem;
  }

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .tab {
    padding: 0.25rem 0.6rem;
    border: 1px solid var(--haven-border, #3c4043);
    border-radius: 999px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .tab:hover,
  .tab:focus-visible {
    border-color: var(--haven-accent, #8ab4f8);
  }

  .tab--active {
    background: var(--haven-accent, #8ab4f8);
    border-color: var(--haven-accent, #8ab4f8);
    color: var(--haven-accent-fg, #202124);
  }

  .sort {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
  }

  .sort__select {
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--haven-border, #3c4043);
    border-radius: 6px;
    background: var(--haven-surface, #202124);
    color: inherit;
    font: inherit;
    font-size: 0.8rem;
  }

  /* ── Card grid ────────────────────────────────────────────────────── */

  .grid {
    display: grid;
    /* auto-fill + minmax is what makes this responsive without a media query:
       the grid becomes a single column on a phone on its own. */
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr));
    gap: 0.6rem;
    overflow-y: auto;
    min-height: 0;
  }

  /* Below the mobile breakpoint, force one column and drop the padding a
     little — a two-column grid of 15rem cards is unusable on a narrow phone. */
  @container (max-width: 26rem) {
    .grid {
      grid-template-columns: 1fr;
    }
    .card {
      padding: 0.5rem;
    }
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    padding: 0.65rem;
    border: 1px solid var(--haven-border, #3c4043);
    border-radius: 10px;
    background: var(--haven-surface, #202124);
  }

  .card__head {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .card__icon {
    width: 28px;
    height: 28px;
    flex: 0 0 auto;
    object-fit: contain;
    border-radius: 6px;
  }

  .card__titles {
    flex: 1 1 auto;
    min-width: 0;
  }

  .card__name {
    display: block;
    color: inherit;
    font-weight: 600;
    text-decoration: none;
    overflow-wrap: anywhere;
  }

  .card__name:hover,
  .card__name:focus-visible {
    color: var(--haven-accent, #8ab4f8);
    text-decoration: underline;
  }

  .card__description {
    margin: 0.15rem 0 0;
    font-size: 0.78rem;
    opacity: 0.75;
    overflow-wrap: anywhere;
  }

  /* ── Status dot ───────────────────────────────────────────────────── */

  /* Colour is a redundant cue only. The meaning is carried by title,
     aria-label and the visually-hidden text inside the dot. */
  .dot {
    position: relative;
    flex: 0 0 auto;
    width: 10px;
    height: 10px;
    margin-top: 0.3rem;
    border-radius: 50%;
    background: var(--haven-unknown, #9aa0a6);
    border: 1px solid rgba(0, 0, 0, 0.35);
  }

  .dot--reachable {
    background: var(--haven-ok, #34a853);
  }

  .dot--unreachable {
    background: var(--haven-bad, #ea4335);
  }

  .dot--checking {
    background: var(--haven-warn, #fbbc04);
    animation: haven-pulse 1.2s ease-in-out infinite;
  }

  .dot--unknown {
    background: var(--haven-unknown, #9aa0a6);
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
    gap: 0.4rem;
    font-size: 0.72rem;
  }

  .version {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
    padding: 0.1rem 0.35rem;
    border: 1px solid var(--haven-border, #3c4043);
    border-radius: 5px;
    font-variant-numeric: tabular-nums;
  }

  .version__tag {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    opacity: 0.6;
  }

  /* The difference between the two is the whole point of the feature, so it
     gets a colour AND a text badge rather than colour alone. */
  .versions--update .version--latest {
    border-color: var(--haven-warn, #fbbc04);
    color: var(--haven-warn, #fbbc04);
  }

  .badge {
    padding: 0.05rem 0.35rem;
    border-radius: 999px;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  .badge--update {
    background: var(--haven-warn, #fbbc04);
    color: var(--haven-accent-fg, #202124);
  }

  /* ── Secondary URL menu ───────────────────────────────────────────── */

  .menu__toggle {
    padding: 0.2rem 0.45rem;
    border: 1px dashed var(--haven-border, #3c4043);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
  }

  .menu__toggle:hover,
  .menu__toggle:focus-visible {
    border-style: solid;
    border-color: var(--haven-accent, #8ab4f8);
  }

  .menu__list {
    list-style: none;
    margin: 0.35rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .menu__list a {
    display: block;
    padding: 0.2rem 0.35rem;
    border-radius: 5px;
    color: inherit;
    font-size: 0.75rem;
    text-decoration: none;
  }

  .menu__list a:hover,
  .menu__list a:focus-visible {
    background: var(--haven-hover, #2d2e31);
    color: var(--haven-accent, #8ab4f8);
  }

  .empty {
    margin: 0;
    padding: 1rem;
    opacity: 0.65;
    font-size: 0.85rem;
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
