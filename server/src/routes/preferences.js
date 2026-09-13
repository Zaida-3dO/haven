/**
 * Dashboard preferences — `/api/preferences`.
 *
 * GET   /api/preferences — every preference, defaults filled in.
 * PATCH /api/preferences — write one or more preferences, leaving the rest alone.
 *
 * ── Why PATCH and not PUT ────────────────────────────────────────────────
 * `/api/layout` is a PUT because a breakpoint's payload is the WHOLE layout
 * for that breakpoint — sending it replaces it, and a partial node list would
 * mean "delete the tiles I omitted". Preferences are the opposite: independent
 * scalars with no relationship to each other, so omitting one must mean "leave
 * it", never "clear it". PATCH is the verb that says so, and it keeps a future
 * second preference from forcing every existing writer to send both.
 */

import {
  PreferenceValidationError,
  createPreferenceStore,
  validatePreferences,
} from '../db/preferences-store.js';

export async function registerPreferenceRoutes(app) {
  const store = createPreferenceStore(app.db);

  app.get('/api/preferences', async (request, reply) => {
    // The sidebar width changes when the user drags it, and a stale one
    // renders the column at the wrong size on the next load. Never cached —
    // same rule as the roster.
    reply.header('cache-control', 'no-store');
    return { preferences: store.getAll() };
  });

  app.patch('/api/preferences', async (request, reply) => {
    let validated;

    try {
      // Validated before the database is touched: a malformed preference is
      // rejected outright rather than stored and cleaned up later.
      validated = validatePreferences(request.body);
    } catch (err) {
      if (err instanceof PreferenceValidationError) {
        return reply.code(400).send({ error: 'INVALID_PREFERENCE', message: err.message });
      }
      throw err;
    }

    const preferences = store.save(validated);
    return reply.code(200).send({ preferences, saved: Object.keys(validated) });
  });
}
