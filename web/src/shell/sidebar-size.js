/**
 * Sidebar sizing: the width of the column, and the height of each card.
 *
 * Ope, 2026-09-13: *"i would like to reduce the height of the calendar widget
 * it's too tall id rather have an internal scroll bar on the widget we should
 * be able to resize their height like we can on the main page"* — plus a
 * sidebar he can drag wider.
 *
 * Kept out of `boot.js` for the same reason as `sidebar-zone.js`: `boot.js`
 * imports GridStack, whose published ESM uses extensionless imports that Vite
 * resolves and Node does not, so anything importing it CANNOT be unit-tested
 * under `node --test`. The rules worth testing live here; `boot.js` keeps only
 * the wiring.
 *
 * ── The invariant this module must not break ─────────────────────────────
 * `.haven-sidebar__scroll` holds the unpinned cards and the pinned Server
 * Status card sits OUTSIDE it as a sibling. That structure is what makes
 * overflow reachable instead of clipped, and it is load-bearing: measured at
 * 1440x900, three cards appended beside the pin drive the scrollport's
 * `clientHeight` to 0px, and `.haven-sidebar { overflow: hidden }` then leaves
 * them unreachable with no scrollbar.
 *
 * A reviewer previously established that no `min-height` floor is needed on
 * the scrollport BECAUSE the pinned card is content-sized (`margin-top: auto`,
 * no fixed height) while the scrollport is `flex: 1 1 auto; min-height: 0`.
 * User-settable heights could break that premise, so this module is built so
 * they cannot:
 *
 *  1. **A height is applied to the card BODY, never to the card or the
 *     sidebar.** `.haven-sidebar__body { height: Npx; overflow-y: auto }`
 *     BOUNDS a card's contribution to the scrollport's content height. Setting
 *     a height can only ever make a card shorter than its intrinsic content —
 *     the case that starves the scrollport is a card growing without limit,
 *     which this shape cannot express.
 *
 *  2. **The pinned card is not resizable.** It is the sidebar's own child, so
 *     a height on it would compete with the scrollport for the column's space
 *     rather than being absorbed by it — exactly the starvation the structure
 *     exists to prevent. It stays content-sized, which is the premise the
 *     no-floor argument rests on.
 *
 * Both are asserted in `web/test/sidebar-size.test.js` and behaviourally in
 * `web/e2e/sidebar-sizing.spec.js`.
 */

import { SIDEBAR_WIDTH, clampSidebarWidth } from './preferences-client.js';

export { SIDEBAR_WIDTH, clampSidebarWidth };

/**
 * The shortest a card may be dragged, in pixels.
 *
 * Mirrors `MIN_CARD_HEIGHT` in `server/src/db/instances-store.js` so the drag
 * stops where the validator would refuse. A card shorter than its own heading
 * is a label with a scrollbar: the title row alone is ~34px, so below this
 * there is no body left to scroll in.
 */
export const MIN_CARD_HEIGHT = 80;

/**
 * The tallest a card may be dragged, in pixels.
 *
 * There is no correctness need for a ceiling — a body with a fixed height
 * scrolls internally however tall it is, so a huge value cannot starve the
 * scrollport the way an unbounded card can. It exists so a runaway drag cannot
 * leave a card taller than any plausible viewport, which would put the cards
 * below it beyond a very long scroll for no reason.
 */
export const MAX_CARD_HEIGHT = 2000;

/** Clamps a card height to the allowed range. */
export const clampCardHeight = (value) =>
  Math.min(MAX_CARD_HEIGHT, Math.max(MIN_CARD_HEIGHT, Math.round(value)));

/**
 * Applies a card height to the DOM, or clears it.
 *
 * `null` removes the inline height so the card falls back to content sizing —
 * the sidebar's documented default (DESIGN §3.1). That is why this takes null
 * rather than treating a falsy value as "no change": clearing a height must be
 * expressible.
 *
 * The height goes on the BODY, not the card. See the note at the top of this
 * file: bounding the body is what makes a user-set height incapable of
 * starving the scrollport.
 *
 * @param {{body: HTMLElement, pinned?: boolean}} card a card from `createSidebar`
 * @param {number|null} height pixels, or null for content sizing
 * @returns {boolean} whether a height was applied
 */
export function applyCardHeight(card, height) {
  const body = card?.body;
  if (!body) return false;

  // The pinned card is the sidebar's own child rather than a child of the
  // scrollport, so a fixed height on it takes space FROM the scrollport
  // instead of being absorbed by it. Refused outright rather than clamped.
  if (card.pinned) return false;

  if (height === null || height === undefined) {
    body.style.height = '';
    body.style.overflowY = '';
    return false;
  }

  const clamped = clampCardHeight(height);
  body.style.height = `${clamped}px`;
  // The whole point of the feature: content taller than the card scrolls
  // INSIDE it rather than being clipped. Without this the height is a crop.
  body.style.overflowY = 'auto';
  return true;
}

/**
 * Applies the sidebar's width by setting the CSS custom property the layout
 * already reads.
 *
 * `--haven-sidebar-width` is consumed by
 * `grid-template-columns: 1fr var(--haven-sidebar-width)`, so setting it on the
 * layout element resizes the track without this module knowing anything about
 * the grid. Set on the LAYOUT rather than on `:root` so it is scoped to the
 * dashboard and a test can assert it without reading global state.
 *
 * Below 1024px the property is ignored by the cascade — the sidebar stops
 * being a column there — so there is deliberately no breakpoint check here.
 * The stylesheet already expresses it.
 *
 * @returns {number} the width actually applied, after clamping
 */
export function applySidebarWidth(layoutEl, width) {
  const clamped = clampSidebarWidth(width);
  layoutEl?.style?.setProperty?.('--haven-sidebar-width', `${clamped}px`);
  return clamped;
}

/**
 * Creates the sizing controller.
 *
 * ── Drafting ─────────────────────────────────────────────────────────────
 * Every change made here is held IN MEMORY until `commit()`. Nothing is
 * written to the server as it is dragged. That is deliberate and matches the
 * direction the edit-mode work is taking the sidebar: Ope asked that sidebar
 * changes be drafted — *"changes should be drafted if i don't click save and i
 * refresh my changes should be lost not persisted"* — so a resize that
 * persisted on mouse-up would contradict it, and `discard()` would have
 * nothing to restore.
 *
 * So this exposes the same three-verb shape edit mode already uses:
 * `snapshot()` on entry, `commit()` from Save, `discard()` from Discard.
 *
 * @param {object} deps
 * @param {object} deps.sidebar handle from `createSidebar`
 * @param {HTMLElement} deps.layoutEl the `.haven-layout` element
 * @param {object} [deps.preferencesClient] null when there is no server
 * @param {object} [deps.instancesClient] null when the roster was injected
 * @param {() => Array<object>} [deps.entries] the sidebar zone's entries
 * @param {(err: Error) => void} [deps.onError]
 */
export function createSidebarSizing({
  sidebar,
  layoutEl,
  preferencesClient = null,
  instancesClient = null,
  entries = () => [],
  secretKeysFor = () => [],
  onError = (error) => console.error('Haven: a sidebar size could not be saved.', error),
} = {}) {
  if (!sidebar) throw new Error('createSidebarSizing: a sidebar is required');

  /** The width as currently shown. */
  let width = SIDEBAR_WIDTH.default;
  /** id → height in pixels, or null for content sizing. */
  const heights = new Map();

  /** What everything was when edit mode was entered, for Discard. */
  let snapshot = null;

  return {
    get width() {
      return width;
    },

    /** The drafted height for one card, or null. */
    heightFor(id) {
      return heights.get(id) ?? null;
    },

    /**
     * Seeds from persisted state and renders it. Called once at boot.
     *
     * Heights come off the roster entries, so a card with no stored height
     * keeps content sizing rather than being given a computed default — the
     * default IS "as tall as your content".
     */
    load({ sidebarWidth, entries: loaded = [] } = {}) {
      if (sidebarWidth !== undefined) width = applySidebarWidth(layoutEl, sidebarWidth);

      for (const entry of loaded) {
        if (entry?.id === undefined) continue;
        const height = entry.height ?? null;
        heights.set(entry.id, height);
        const card = sidebar.cards.get(entry.id);
        if (card) applyCardHeight(card, height);
      }
      return this;
    },

    /** Records the current sizes so `discard()` can restore them. */
    snapshot() {
      snapshot = { width, heights: new Map(heights) };
      return this;
    },

    /** Whether anything has been resized since `snapshot()`. */
    get isDirty() {
      if (!snapshot) return false;
      if (snapshot.width !== width) return true;

      // A height added, removed or changed all count. Compared in both
      // directions, because a card whose height was CLEARED has an entry in
      // the snapshot and none now.
      const ids = new Set([...snapshot.heights.keys(), ...heights.keys()]);
      for (const id of ids) {
        if ((snapshot.heights.get(id) ?? null) !== (heights.get(id) ?? null)) return true;
      }
      return false;
    },

    /**
     * Sets the sidebar's width, live. Drafted, not persisted.
     *
     * @returns {number} the width actually applied, after clamping
     */
    setWidth(next) {
      width = applySidebarWidth(layoutEl, next);
      return width;
    },

    /**
     * Sets one card's height, live. Drafted, not persisted.
     *
     * Refuses the pinned card — see `applyCardHeight`.
     *
     * @returns {boolean} whether the height was applied
     */
    setHeight(id, height) {
      const card = sidebar.cards.get(id);
      if (!card || card.pinned) return false;

      const next = height === null ? null : clampCardHeight(height);
      applyCardHeight(card, next);
      heights.set(id, next);
      return true;
    },

    /**
     * Restores the sizes as they were on entry to edit mode.
     *
     * Re-applies to the DOM as well as to the model: a discard that only reset
     * the numbers would leave the column visibly the wrong size until reload.
     */
    discard() {
      if (!snapshot) return this;

      width = applySidebarWidth(layoutEl, snapshot.width);

      // Every id in EITHER map, so a height added this session is cleared
      // rather than left applied.
      for (const id of new Set([...snapshot.heights.keys(), ...heights.keys()])) {
        const restored = snapshot.heights.get(id) ?? null;
        heights.set(id, restored);
        const card = sidebar.cards.get(id);
        if (card) applyCardHeight(card, restored);
      }

      snapshot = null;
      return this;
    },

    /**
     * Persists everything that changed since `snapshot()`.
     *
     * Only what CHANGED is written: each height costs a PUT of a whole
     * instance, so resizing one card in a four-card sidebar must write one row
     * rather than four — the same rule `renumber` follows in `sidebar-zone.js`.
     *
     * The width and the heights go to two different endpoints because they are
     * two different kinds of state (see migration 007). Both are awaited so a
     * failure surfaces rather than becoming an unhandled rejection.
     */
    async commit() {
      const before = snapshot;
      snapshot = null;
      if (!before) return { width: false, heights: [] };

      const saved = { width: false, heights: [] };

      if (before.width !== width && preferencesClient) {
        try {
          await preferencesClient.save({ sidebarWidth: width });
          saved.width = true;
        } catch (error) {
          onError(error);
        }
      }

      if (instancesClient) {
        const byId = new Map(entries().map((entry) => [entry.id, entry]));

        for (const [id, height] of heights) {
          if ((before.heights.get(id) ?? null) === (height ?? null)) continue;
          const entry = byId.get(id);
          if (!entry) continue;

          try {
            // The whole instance goes back, with the height replaced. The
            // roster entry is the source for everything else — sending a
            // partial would reset `zone` and `sortOrder`, which the server
            // reads as a relocation.
            await instancesClient.save(
              id,
              { ...entry, height, zone: 'sidebar' },
              { secretKeys: secretKeysFor(entry.type) }
            );
            saved.heights.push(id);
          } catch (error) {
            onError(error);
          }
        }
      }

      return saved;
    },
  };
}

export default {
  createSidebarSizing,
  applyCardHeight,
  applySidebarWidth,
  clampCardHeight,
  clampSidebarWidth,
  MIN_CARD_HEIGHT,
  MAX_CARD_HEIGHT,
  SIDEBAR_WIDTH,
};
