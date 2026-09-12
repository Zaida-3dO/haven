/**
 * The sidebar zone: adding, reordering and removing its widgets.
 *
 * Kept out of `boot.js` deliberately, and this is not a style preference:
 * `boot.js` imports GridStack, whose published ESM uses extensionless imports
 * that Vite resolves and Node does not, so anything importing it CANNOT be
 * unit-tested under `node --test`. This is the same split, for the same
 * reason, as `roster.js` out of `boot.js` and `grid-layout.js` out of
 * `grid.js` — the logic worth testing lives here, and `boot.js` keeps the
 * wiring.
 *
 * ── What "reorder" means here, and why it is not a grid ──────────────────
 * The sidebar is one column of intrinsically-sized cards, so the only free
 * variable is ORDER. That maps exactly onto `sort_order`, the column the
 * roster already carries — there is no geometry to compute and nothing to
 * collapse back into an index. A one-column GridStack would compute
 * `{x,y,w,h}` only to throw it away, and would lose the pinned card's
 * `margin-top: auto`, which flex gives for free. See `docs/DESIGN.md` §3.1.
 *
 * ── Two invariants this module exists to hold ────────────────────────────
 *
 * **1. An unpinned card goes INSIDE `.haven-sidebar__scroll`.** Appending it
 * to the sidebar itself makes it a sibling of the pinned card, which starves
 * the scrollport: measured at 1440x900, three such siblings drive the
 * scrollport's `clientHeight` to 0px, and because `.haven-sidebar` is
 * `overflow: hidden` those cards are then unreachable with no scrollbar to
 * find them — persisted, invisible, and unrecoverable from the UI.
 *
 * **2. A move RE-PARENTS the host, it never destroys and rebuilds it.**
 * `dashboard.remove(id)` calls `host.destroy()`, which tears down the element
 * and its shadow root; following it with `dashboard.add()` would reload every
 * moved widget and, for the 3D home, reload the entire WebGL scene.
 * `host.root` is stable and exposed precisely so a caller can move it, and
 * `appendChild` detaches before it appends — so re-appending the cards in the
 * desired order IS the reorder, with no teardown at all.
 */

/** Cards are ordered by `sortOrder`, then by id so the order is total. */
const byOrder = (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id);

/**
 * Reorders a list of entries by moving one of them.
 *
 * Pure, and exported, so the rule can be tested without a DOM, a dashboard or
 * a server. Returns a NEW array; the input is not mutated.
 *
 * A move that would fall off either end returns the list unchanged rather than
 * wrapping around. Wrapping reads as a bug to someone holding an arrow down:
 * the top card suddenly appearing at the bottom is indistinguishable from a
 * misclick, whereas "nothing happened" explains itself.
 *
 * @param {Array<{id: string}>} entries in their current display order
 * @param {string} id the entry to move
 * @param {number} delta -1 for up, +1 for down
 * @returns {Array<object>} the new order
 */
export function reorder(entries, id, delta) {
  const list = [...entries];
  const from = list.findIndex((entry) => entry?.id === id);
  if (from < 0) return list;

  const to = from + delta;
  if (to < 0 || to >= list.length) return list;

  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return list;
}

/**
 * Renumbers a list so `sortOrder` matches position.
 *
 * The persisted order is a dense `0..n-1` per zone, which is what lets a list
 * index map onto it directly. Returns only the entries whose number actually
 * CHANGED, because each one costs a PUT: moving the last card up in a
 * four-card sidebar should write two rows, not four.
 *
 * @returns {{ entries: Array<object>, changed: Array<object> }}
 */
export function renumber(entries) {
  const changed = [];
  const renumbered = entries.map((entry, index) => {
    if ((entry.sortOrder ?? 0) === index) return entry;
    const next = { ...entry, sortOrder: index };
    changed.push(next);
    return next;
  });
  return { entries: renumbered, changed };
}

/**
 * Creates the sidebar-zone controller.
 *
 * @param {object} deps
 * @param {object} deps.sidebar   the handle from `createSidebar`
 * @param {object} deps.dashboard the widget host's Dashboard
 * @param {object} [deps.instancesClient] null when the roster was injected
 * @param {(entry: object) => object} deps.cardSpecFor entry → card spec
 * @param {(type: string) => Array<string>} [deps.secretKeysFor]
 * @param {(err: Error) => void} [deps.onError]
 */
export function createSidebarZone({
  sidebar,
  dashboard,
  instancesClient = null,
  cardSpecFor,
  secretKeysFor = () => [],
  onError = (error) => console.error('Haven: a sidebar change could not be saved.', error),
} = {}) {
  if (!sidebar) throw new Error('createSidebarZone: a sidebar is required');
  if (!dashboard) throw new Error('createSidebarZone: a dashboard is required');
  if (typeof cardSpecFor !== 'function') {
    throw new Error('createSidebarZone: cardSpecFor is required');
  }

  /** The zone's entries, in display order. */
  let entries = [];

  /**
   * Persists one entry's placement.
   *
   * A null client is the injected-roster case (`bootDashboard({instances})`),
   * where there is no server to talk to and persisting would be meaningless.
   */
  const persist = (entry) => {
    if (!instancesClient) return;
    void instancesClient
      .save(entry.id, { ...entry, zone: 'sidebar' }, { secretKeys: secretKeysFor(entry.type) })
      .catch(onError);
  };

  /**
   * Re-appends every unpinned card in `entries` order.
   *
   * The pinned card is skipped rather than repositioned: it is the sidebar's
   * own child rather than a child of the scrollport, so re-appending the
   * scrollport's children cannot move it — and must not accidentally pull it
   * inside, which would let it scroll out of view.
   */
  const applyOrder = () => {
    for (const entry of entries) {
      const card = sidebar.cards.get(entry.id);
      if (!card || card.pinned) continue;
      // `appendChild` detaches first, so this MOVES the existing element.
      // Nothing is rebuilt and no widget host is touched.
      sidebar.scroll.appendChild(card.el);
    }
  };

  return {
    /** The entries as last known, in display order. */
    get entries() {
      return [...entries];
    },

    /** Seeds the controller from the roster. Does not touch the DOM. */
    load(sidebarEntries) {
      entries = [...sidebarEntries].sort(byOrder);
      return this.entries;
    },

    /**
     * Moves one widget up or down, persisting the new order immediately.
     *
     * Persisted on the click rather than behind a Save button: a click on an
     * arrow is one discrete, complete act, and there is no half-finished state
     * a Discard could meaningfully restore. The grid is different — a drag is
     * a continuous gesture with an obvious commit point — which is why edit
     * mode's Save/Discard governs geometry and not this.
     */
    move(id, delta) {
      const next = reorder(entries, id, delta);
      // A no-op move (already at an end) must not write rows for nothing.
      if (next.every((entry, i) => entry.id === entries[i]?.id)) return this.entries;

      const { entries: renumbered, changed } = renumber(next);
      entries = renumbered;
      applyOrder();
      for (const entry of changed) persist(entry);
      return this.entries;
    },

    /**
     * Adds a widget to the sidebar.
     *
     * Returns the host, or null when the widget could not be mounted — an
     * unknown type is a roster naming a widget this build does not have, and
     * that must not throw.
     */
    add(entry) {
      const card = sidebar.addCard(cardSpecFor(entry));
      if (!card) return null;

      const host = dashboard.add(
        { id: entry.id, type: entry.type, config: entry.config ?? {} },
        card.body
      );

      if (!host) {
        // Roll the card back rather than leaving an empty titled box behind.
        card.el.remove();
        sidebar.cards.delete(entry.id);
        sidebar.bodies.delete(entry.id);
        return null;
      }

      entries = [...entries, { ...entry, zone: 'sidebar', sortOrder: entries.length }];
      return host;
    },

    /** Removes a widget from the sidebar, its card and the roster. */
    remove(id) {
      const card = sidebar.cards.get(id);
      if (!card) return false;

      // The host first: `dashboard.remove` destroys it and drops its search
      // entries and its scheduler task. Removing the card out from under a
      // live host would leave that host mounted into a detached element.
      dashboard.remove(id);
      card.el.remove();
      sidebar.cards.delete(id);
      sidebar.bodies.delete(id);

      entries = entries.filter((entry) => entry.id !== id);

      // Renumber what is left, so the order stays a dense 0..n-1 rather than
      // developing a hole that later index arithmetic has to reason about.
      const { entries: renumbered, changed } = renumber(entries);
      entries = renumbered;

      if (instancesClient) {
        void instancesClient.remove(id).catch(onError);
        for (const entry of changed) persist(entry);
      }
      return true;
    },
  };
}

export default { createSidebarZone, reorder, renumber };
