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
 * ── Changes are DRAFTED while edit mode is open ──────────────────────────
 * Reorders and removals used to be written to the server on the click. That
 * made a refresh without saving KEEP the change, and made Discard unable to
 * undo a removal at all, because the row was already gone. Both are now
 * buffered until Save: see `beginDraft` / `commitDraft` / `cancelDraft`.
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
 * **Never mutates an input entry — this is load-bearing, not incidental.**
 * `cancelDraft`'s restore assigns `entries = draftEntries` straight from the
 * snapshot taken in `beginDraft`; if a later `renumber` call mutated an entry
 * object in place, that same object would still be sitting in `draftEntries`
 * and Discard would restore something already changed rather than the
 * original. Every entry that needs a new `sortOrder` is copied with `{
 * ...entry, sortOrder: index }` for exactly this reason.
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
   * The entries as they were when the draft opened, or null outside a draft.
   *
   * This is the sidebar's half of the snapshot/restore model edit mode already
   * uses for the grid (`snapshotLayout` in `edit-mode.js`), and deliberately
   * not a parallel mechanism: the grid snapshots geometry because geometry is
   * its free variable, and the sidebar snapshots ORDER because order is its
   * only one. Discard restores from here exactly as the grid's Discard
   * restores from its own snapshot.
   */
  let draftEntries = null;

  /**
   * Ids removed during the draft, in click order, with the card kept alive.
   *
   * A removal is buffered rather than performed because `dashboard.remove(id)`
   * calls `host.destroy()`, which tears down the element AND its shadow root.
   * Once that has happened there is nothing left to restore — bringing the
   * widget back would mean building a fresh host and reloading it from
   * scratch, which for the 3D home means its entire WebGL scene. So a removal
   * in a draft only HIDES the card; the teardown happens on Save, and Discard
   * simply shows it again.
   */
  let pendingRemovals = [];

  const drafting = () => draftEntries !== null;

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
   * Hides or shows a card without detaching it.
   *
   * `hidden` rather than `el.remove()`, because the card has to stay in the
   * scrollport for Discard to be able to put it back in place: a detached
   * element would have to be re-appended at the right index, which re-derives
   * an order the entries already hold. Hiding leaves the DOM order alone and
   * makes restoring it a single flag flip.
   */
  const setCardHidden = (id, hidden) => {
    const card = sidebar.cards.get(id);
    if (card?.el) card.el.hidden = hidden;
  };

  /** Tears a widget down for real: host, card and the sidebar's maps. */
  const destroyCard = (id) => {
    const card = sidebar.cards.get(id);
    if (!card) return false;

    // The host first: `dashboard.remove` destroys it and drops its search
    // entries and its scheduler task. Removing the card out from under a
    // live host would leave that host mounted into a detached element.
    dashboard.remove(id);
    card.el.remove();
    sidebar.cards.delete(id);
    sidebar.bodies.delete(id);
    return true;
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

    /** Whether a draft is currently open. */
    get drafting() {
      return drafting();
    },

    /**
     * Whether this draft holds anything a Save would write.
     *
     * Two things count, and they are checked separately because one of them
     * is invisible in the order alone: a pending removal leaves the surviving
     * entries renumbered 0..n-1, which for a removal from the END is the same
     * list of ids in the same order as the snapshot. Comparing ids only would
     * report that draft as clean and leave Save greyed out over a real change.
     */
    get isDirty() {
      if (!drafting()) return false;
      if (pendingRemovals.length > 0) return true;
      if (entries.length !== draftEntries.length) return true;
      return entries.some((entry, i) => entry.id !== draftEntries[i]?.id);
    },

    /**
     * Opens a draft: from here until `commitDraft`/`cancelDraft`, reorders and
     * removals are buffered in memory instead of being written to the server.
     *
     * Called on entry to edit mode, never later — the same rule as the grid's
     * snapshot, and for the same reason: re-snapshotting mid-session would
     * silently move the point Discard returns to.
     */
    beginDraft() {
      if (drafting()) return;
      draftEntries = [...entries];
      pendingRemovals = [];
    },

    /**
     * Applies the draft: tears down what was removed, writes what moved.
     *
     * The teardown happens HERE rather than at click time, which is the whole
     * point of the draft — see `pendingRemovals`. Order matters: the hosts go
     * first, then the surviving rows are renumbered on the server, so a
     * reordered survivor is never written with a `sortOrder` that a
     * still-pending removal is about to invalidate.
     */
    commitDraft() {
      if (!drafting()) return this.entries;

      for (const id of pendingRemovals) {
        destroyCard(id);
        if (instancesClient) void instancesClient.remove(id).catch(onError);
      }

      // Every surviving row whose number differs from the snapshot, written
      // once. `renumber` has already made `entries` dense, so this compares
      // against the order the draft opened with rather than re-deriving it.
      const before = new Map(draftEntries.map((entry) => [entry.id, entry.sortOrder ?? 0]));
      for (const entry of entries) {
        if (before.get(entry.id) !== entry.sortOrder) persist(entry);
      }

      draftEntries = null;
      pendingRemovals = [];
      return this.entries;
    },

    /**
     * Abandons the draft, restoring the order and every card removed in it.
     *
     * This is the half that was impossible before: a removal used to delete
     * the row server-side on the click, so there was nothing for a Discard to
     * put back. Nothing has been destroyed or deleted here, so restoring is
     * un-hiding the cards, un-suspending their hosts (scheduler task + search
     * entry, the exact inverse of `remove`'s `dashboard.suspend`) and
     * re-applying the snapshotted order.
     */
    cancelDraft() {
      if (!drafting()) return this.entries;

      for (const id of pendingRemovals) {
        setCardHidden(id, false);
        dashboard.resume(id);
      }
      pendingRemovals = [];

      entries = draftEntries;
      draftEntries = null;
      applyOrder();
      return this.entries;
    },

    /**
     * Moves one widget up or down.
     *
     * **Inside a draft the new order is held in memory**, so refreshing
     * without saving loses it — which is what a draft means, and what Ope
     * asked for: "changes should be drafted if i don't click save and i
     * refresh my changes should be lost not persisted".
     *
     * Outside a draft (no edit mode open) the move persists immediately, so
     * the injected-roster and programmatic callers keep their old behaviour.
     */
    move(id, delta) {
      const next = reorder(entries, id, delta);
      // A no-op move (already at an end) must not write rows for nothing.
      if (next.every((entry, i) => entry.id === entries[i]?.id)) return this.entries;

      const { entries: renumbered, changed } = renumber(next);
      entries = renumbered;
      applyOrder();
      if (!drafting()) {
        for (const entry of changed) persist(entry);
      }
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

    /**
     * Removes a widget from the sidebar.
     *
     * **Inside a draft nothing is destroyed and nothing is deleted.** The card
     * is hidden and the id is buffered, so Discard can bring it back — see
     * `pendingRemovals` for why a destroyed host could not be restored. The
     * host itself survives too, but it is SUSPENDED: `dashboard.suspend(id)`
     * drops its scheduler task and its search-index entry, the same two
     * things `dashboard.remove(id)` drops, without the `host.destroy()` that
     * would make it unrestorable. Otherwise a card hidden in a draft kept
     * polling its endpoint and kept turning up in Ctrl+K until Save/Discard.
     *
     * Outside a draft this is immediate and irreversible, as it always was.
     */
    remove(id) {
      const card = sidebar.cards.get(id);
      if (!card) return false;

      if (drafting()) {
        pendingRemovals.push(id);
        setCardHidden(id, true);
        dashboard.suspend(id);
      } else {
        destroyCard(id);
      }

      entries = entries.filter((entry) => entry.id !== id);

      // Renumber what is left, so the order stays a dense 0..n-1 rather than
      // developing a hole that later index arithmetic has to reason about.
      const { entries: renumbered, changed } = renumber(entries);
      entries = renumbered;

      if (instancesClient && !drafting()) {
        void instancesClient.remove(id).catch(onError);
        for (const entry of changed) persist(entry);
      }
      return true;
    },

    /**
     * Records a widget's new CONFIG against this zone's own copy of the
     * entry, without touching order or persisting anything itself.
     *
     * `entries` carries its own `config` per row, entirely separate from
     * `boot.js`'s `roster` map — the settings panel's save updates the
     * latter, and nothing kept the two in step. That gap was silent and real:
     * saving a sidebar widget's settings DURING an open reorder draft (edit
     * mode entered, a card moved, Save not yet clicked) appeared to work —
     * the host updated, the dialog closed, the new value round-tripped to the
     * server in that moment — and then `commitDraft()`'s own renumber pass
     * persisted every entry whose `sortOrder` changed using ITS copy of the
     * entry, which still carried the config from whenever the draft began.
     * The config save was silently overwritten the instant the reorder was
     * saved. Reproduced live: changed a sidebar calendar's `maxEvents` to 42
     * during an open drag draft, saw it persist immediately, then clicked
     * toolbar Save for the reorder and watched the database go back to 8.
     *
     * Called unconditionally, drafting or not: a config save is never
     * drafted — only reorders and removals are — so there is no snapshot
     * half of this to preserve for Discard, unlike `move`/`remove` above.
     */
    updateConfig(id, config) {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      entries = entries.map((entry, i) => (i === index ? { ...entry, config } : entry));
      return true;
    },
  };
}

export default { createSidebarZone, reorder, renumber };
