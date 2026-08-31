/**
 * Reconciling the roster against the saved layout.
 *
 * The dashboard's persisted state is split across two endpoints: `/api/layout`
 * holds geometry per breakpoint, `/api/instances` holds which widgets exist.
 * They are joined by instance id, and nothing enforces that join at the
 * database level — so the join can be stale in either direction, and this
 * module is where that is handled.
 *
 * Kept out of `boot.js` deliberately: `boot.js` imports GridStack, whose ESM
 * uses extensionless imports that Vite resolves and Node does not, so anything
 * importing it is untestable under `node --test`. This is the same split, and
 * for the same reason, as `grid-layout.js` out of `grid.js`.
 */

/**
 * Pairs a roster with the layout nodes that actually refer to it.
 *
 * ── The failure this prevents ────────────────────────────────────────────
 * A layout node whose `widgetId` names an instance that no longer exists is a
 * dangling reference. It happens whenever a delete half-lands, or a database is
 * restored from a backup taken between the two writes. It must degrade to "one
 * tile is missing" and never to a blank dashboard — that is the failure that
 * turns a small bug into an unusable app.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Both directions are handled:
 *
 *  - a layout node with no instance is dropped from `usable`
 *  - a roster entry with no id is dropped from `roster`, because it can never
 *    be addressed, configured or deleted afterwards
 *
 * A roster entry with no layout node is deliberately KEPT: no geometry means
 * "place it at its default position", which is what a newly added widget looks
 * like before the layout is next saved.
 *
 * @param {Array<{id: string, type: string, config: object}>} roster
 * @param {Array<{id: string, widgetId?: string}>} layoutNodes
 * @returns {{ roster: Array<object>, usable: Array<object> }}
 */
export function reconcileRoster(roster = [], layoutNodes = []) {
  const entries = (Array.isArray(roster) ? roster : []).filter(
    (entry) => entry && typeof entry.id === 'string' && entry.id !== ''
  );

  const known = new Set(entries.map((entry) => entry.id));

  const usable = (Array.isArray(layoutNodes) ? layoutNodes : []).filter((node) => {
    // A node may name its instance through `widgetId` or carry the instance id
    // as its own id — the layout validator allows both spellings, so both have
    // to be resolved the same way.
    const target = node?.widgetId ?? node?.id;
    return typeof target === 'string' && known.has(target);
  });

  return { roster: entries, usable };
}
