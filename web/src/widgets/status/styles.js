/**
 * Status widget styles, scoped by the shadow root.
 *
 * Same reasoning as the apps widget's: a string rather than a `.css` file, so
 * the widget carries its own styles into its shadow DOM (which does not see
 * the document stylesheet), and no `var(--haven-*, #fallback)` anywhere — a
 * fallback that only fires when the design is already broken hides the
 * breakage rather than rescuing it.
 */
export const STATUS_STYLES = `
  :host {
    display: block;
    color: var(--haven-fg);
    font-family: var(--haven-font, system-ui, -apple-system, 'Segoe UI', sans-serif);
  }

  .summary {
    display: flex;
    align-items: center;
    gap: var(--haven-space-4);
    font-size: 12px;
  }

  .count {
    display: inline-flex;
    align-items: center;
    gap: var(--haven-space-2);
  }

  .count__value {
    font-size: 14px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .count__label {
    color: var(--haven-fg-secondary);
  }

  /* Shape as well as colour, matching the app cards' dots: reachable is a
     filled disc, unreachable is a ring. Colour is never the only carrier. */
  .count__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .count__dot--online {
    background: var(--haven-ok);
  }

  .count__dot--offline {
    background: transparent;
    border: 2px solid var(--haven-bad);
  }

  /* While probes are outstanding the numbers are provisional, and the card
     says so by dimming rather than by presenting a partial count as final. */
  .summary--pending {
    opacity: 0.65;
  }
`;

export default { STATUS_STYLES };
