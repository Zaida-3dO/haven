/**
 * Widget instance API — `/api/instances`.
 *
 * The roster: which widgets are on the dashboard, what type each one is, and
 * its config. Geometry is NOT here — that is `/api/layout`, one row per
 * breakpoint, and the two are joined by id in the shell (`grid.load`).
 *
 * ── Why not `/api/widgets/instances` ─────────────────────────────────────
 * `routes/widgets.js` already owns `/api/widgets/*`, and it is a different
 * thing entirely: those are the widget DATA endpoints (`/api/widgets/weather`,
 * `/torrents`, `/calendar`, `/hero`), one per connector, whose whole purpose
 * is that the browser never sees a credential. Hanging instance CRUD off the
 * same prefix would put "the roster" and "this widget's upstream data" in one
 * namespace, and `/api/widgets/:id` would then be ambiguous with the connector
 * routes. So the roster gets its own noun.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * On secrets, see the header of `db/instances-store.js`. The short version for
 * a reader of this file: a `secret`-typed config field never comes back out of
 * these routes. The store swaps the value for a sentinel on write and the
 * sentinel is what is served on read, so there is no response shape here that
 * can carry a credential to the browser.
 */

import {
  InstanceValidationError,
  createInstanceStore,
  validateInstance,
} from '../db/instances-store.js';

const badRequest = (reply, message) => reply.code(400).send({ error: 'INVALID_INSTANCE', message });

const notFound = (reply, id) =>
  reply.code(404).send({ error: 'NOT_FOUND', message: `No widget instance with id "${id}".` });

/**
 * Runs a validator, turning its typed error into a 400.
 *
 * @returns {{ ok: true, value: object } | { ok: false }} — on failure the
 *   reply has already been sent.
 */
function validated(reply, payload, options) {
  try {
    return { ok: true, value: validateInstance(payload, options) };
  } catch (err) {
    if (err instanceof InstanceValidationError) {
      badRequest(reply, err.message);
      return { ok: false };
    }
    throw err;
  }
}

export async function registerInstanceRoutes(app, { db, credentials } = {}) {
  const database = db ?? app.db;
  if (!database) throw new Error('registerInstanceRoutes requires a database handle.');

  const store = createInstanceStore(database, { credentials });

  /**
   * GET /api/instances — the whole roster.
   *
   * Always a 200 with an array, empty or not: the shell falls back to its own
   * defaults on a *failed* request, so "no instances" must be distinguishable
   * from "the request did not work".
   */
  app.get('/api/instances', async (request, reply) => {
    // The roster changes when the user adds or configures a widget, and a
    // stale one shows a widget that is no longer there. Never cached.
    reply.header('cache-control', 'no-store');
    return { instances: store.list() };
  });

  app.get('/api/instances/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const found = store.get(request.params.id);
    return found ?? notFound(reply, request.params.id);
  });

  app.post('/api/instances', async (request, reply) => {
    const result = validated(reply, request.body);
    if (!result.ok) return reply;

    if (store.has(result.value.id)) {
      return reply.code(409).send({
        error: 'DUPLICATE_ID',
        message: `A widget instance with id "${result.value.id}" exists.`,
      });
    }

    return reply.code(201).send(store.create(result.value));
  });

  /**
   * PUT /api/instances/:id — full replace of the mutable fields.
   *
   * The id comes from the path, never the body: a PUT must not be able to
   * rename the row it is addressing (same rule as `apps.js`).
   */
  app.put('/api/instances/:id', async (request, reply) => {
    const { id } = request.params;

    const result = validated(reply, request.body, { requireId: false });
    if (!result.ok) return reply;

    const updated = store.update(id, result.value);
    return updated ?? notFound(reply, id);
  });

  /**
   * DELETE /api/instances/:id — the instance, its layout nodes and its
   * credentials, together. See `store.delete` for why all three.
   */
  app.delete('/api/instances/:id', async (request, reply) => {
    if (!store.delete(request.params.id)) return notFound(reply, request.params.id);
    return reply.code(204).send();
  });
}
