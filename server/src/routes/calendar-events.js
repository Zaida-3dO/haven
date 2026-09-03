/**
 * The local calendar write API — `/api/calendar/events`.
 *
 * Ope asked for "a way to post or get calendar entries… that other agents can
 * hit, maybe via an MCP, to place things on the calendar". These are those
 * endpoints:
 *
 *   POST   /api/calendar/events        create one or a batch
 *   PATCH  /api/calendar/events/:id    edit a local event
 *   DELETE /api/calendar/events/:id    remove a local event
 *
 * The merged read (`GET /api/widgets/calendar/events`) lives in
 * `calendar.js` alongside the feeds it merges.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY WRITES CANNOT GO TO THE ICS FEEDS
 *
 * A Google "secret address in iCal format" is a READ credential. There is no
 * write verb on that endpoint at all — writing into Google needs OAuth, which
 * is a much larger job carrying real credential risk, and it has not been
 * chosen yet. So an event created here is stored by Haven, in Haven's own
 * database, and merged into the same view at read time.
 *
 * The consequence a calling agent runs into, and the one thing this module
 * most needs to teach it: AN ICS-SOURCED EVENT CANNOT BE EDITED. Not "is not
 * currently supported" — cannot, because there is nothing to write to. Both
 * write routes say so in those words rather than returning a bare 400, so an
 * agent that tries learns the actual rule on its first attempt. See
 * `refuseForeignEvent` below.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SECURITY POSTURE — READ THIS BEFORE EXPOSING HAVEN
 *
 * There is NO AUTHENTICATION on any Haven route, this one included. That is a
 * documented, deliberate posture (docs/SECURITY.md: "do not port-forward the
 * backend"), and it was defensible while every route was a read. This is the
 * first route that lets an unauthenticated caller put data *into* Haven, so
 * the posture is worth restating rather than inheriting silently.
 *
 * What this endpoint can and cannot do in the wrong hands:
 *
 *   CAN:    add, alter and delete rows in `calendar_events`, i.e. write junk
 *           onto the dashboard, and delete entries someone relied on.
 *   CANNOT: reach an ICS feed, read a feed URL, touch a credential, call Home
 *           Assistant, or read anything the browser cannot already read
 *           unauthenticated.
 *
 * That ceiling is held by three specific choices, and none is incidental:
 *
 *   1. `source` IS NOT A CALLER-SUPPLIED FIELD. It is stamped by the store.
 *      A previous review of this repo found a write endpoint that trusted a
 *      caller-supplied `source` as a privilege boundary, which let an
 *      unauthenticated caller invoke Home Assistant services — the notices
 *      ingest, fixed by reserving the name (see `routes/notices.js`). The
 *      same shape is refused here BY CONSTRUCTION: there is no field a caller
 *      can set that changes what an event is allowed to do, because a local
 *      event is not allowed to *do* anything. It is inert data.
 *   2. NOTHING STORED HERE IS EVER EXECUTED OR FETCHED. A local event has no
 *      `url`, no `target`, no `actions` — deliberately, even though the
 *      notices envelope has all three. An event is rendered, never invoked,
 *      so this endpoint cannot become a request forwarder.
 *   3. THE BODY IS BOUNDED BEFORE IT IS PARSED. Content-type, body bytes and
 *      batch length are all capped below.
 *
 * MY VERDICT, for the record: this SHOULD require a token before it is used
 * in anger, and it does not have one yet. The gap between "reads only" and
 * "writes too" is the gap between a leak needing network access and a
 * *defacement* needing network access, and the second is a materially worse
 * day even with the ceiling above. It is not a blocker for a LAN-only,
 * non-port-forwarded deployment — which is the documented one — and building
 * auth for one route while the other twenty stay open would be security
 * theatre. The right shape is one shared mechanism (a bearer token in `.env`,
 * checked by a hook, applied to every mutating route at once), and that is a
 * task of its own rather than a rider on this one. Until then, treat the
 * write posture as exactly equal to the read posture: anyone on the LAN can
 * do this. Recorded in the PR and in docs/SECURITY.md.
 * ─────────────────────────────────────────────────────────────────────────
 */

import {
  CalendarValidationError,
  parseCalendarEvents,
  parseEventPatch,
} from '../calendar/event-envelope.js';
import {
  deleteEvent,
  getEvent,
  insertEvents,
  isLocalEventId,
  updateEvent,
} from '../db/calendar-store.js';

/**
 * Cap on one ingest batch.
 *
 * The same reasoning as the notices ingest: a caller is a script placing a
 * handful of entries, not a firehose. Twenty-five is generous for "put my
 * week on the calendar" and small enough that a runaway loop is refused
 * rather than absorbed.
 */
export const MAX_BATCH = 25;

/**
 * Cap on the request body, in bytes.
 *
 * Fastify enforces this before the JSON parser runs, so an oversized body is
 * refused without ever being buffered into a parsed object. 64 KiB comfortably
 * holds `MAX_BATCH` events at their maximum field lengths.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/** The one content type accepted. Anything else is refused before parsing. */
const REQUIRED_CONTENT_TYPE = 'application/json';

/**
 * Refuse a write to an event that is not ours to write.
 *
 * The message is the point. An agent that has read the merged view holds ids
 * from both sources and has no way to know the difference until it tries, so
 * the first refusal has to be the whole explanation — what went wrong, why it
 * is not a bug it can retry around, and what it *can* do instead. A generic
 * 400, or a 404 for an event the caller can plainly see, would both teach it
 * the wrong thing.
 *
 * 403, not 400: the request is perfectly well-formed. It is the target that
 * is forbidden, and no amount of fixing the body will help.
 */
function refuseForeignEvent(reply, id, verb) {
  return reply.code(403).send({
    error: 'READ_ONLY_EVENT',
    message:
      `"${id}" comes from a read-only calendar feed, so it cannot be ${verb}. ` +
      'Haven subscribes to those feeds over a secret iCal address, which grants ' +
      'read access only — there is no way to write back to the source calendar. ' +
      'Only events Haven stores itself can be changed; those have an id ' +
      'beginning "local:" and are returned with "source":"local". Create one ' +
      'with POST /api/calendar/events.',
    id,
    source: 'feed',
    editable: false,
  });
}

/**
 * Turn envelope errors into one response.
 *
 * All-or-nothing, and every bad entry reported — a caller posting five events
 * should learn about all three broken ones in one round trip.
 */
function refuseInvalid(reply, errors, total) {
  return reply.code(400).send({
    error: 'INVALID_EVENT',
    message:
      total === 1
        ? errors[0].message
        : `${errors.length} of ${total} events were rejected; nothing was stored.`,
    errors,
  });
}

export async function registerCalendarEventRoutes(app, opts = {}) {
  const db = opts.db ?? app.db;
  const now = opts.now ?? (() => Date.now());
  const idFactory = opts.idFactory;

  /**
   * Guard every write in this module, before the body is looked at.
   *
   * `onRequest` rather than a per-route check so a route added later cannot
   * forget it — the guard is a property of the URL prefix, not of a handler.
   *
   * Content type is checked explicitly rather than left to Fastify's parser
   * because the failure modes differ in a way that matters to a calling
   * agent: Fastify answers 415 for an unknown type but happily accepts a body
   * with NO content-type at all under some configurations, and "no type" is
   * exactly what a hand-rolled HTTP client sends. Requiring it outright means
   * a caller cannot post `text/plain` that happens to parse as JSON — which
   * is also what keeps a simple HTML form (which can only send
   * `application/x-www-form-urlencoded` or `multipart/form-data`) from being
   * able to reach this endpoint cross-origin at all.
   */
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/calendar/events')) return;
    if (request.method === 'GET' || request.method === 'HEAD') return;
    if (request.method === 'DELETE') return; // no body to type-check

    const contentType = request.headers['content-type'] ?? '';
    // Compare the media type only — `application/json; charset=utf-8` is fine.
    const mediaType = contentType.split(';')[0].trim().toLowerCase();

    if (mediaType !== REQUIRED_CONTENT_TYPE) {
      return reply.code(415).send({
        error: 'UNSUPPORTED_MEDIA_TYPE',
        message:
          `Send ${REQUIRED_CONTENT_TYPE}` +
          (mediaType ? ` (got "${mediaType}").` : ' — no Content-Type header was sent.'),
      });
    }
  });

  /**
   * POST /api/calendar/events — create one event or a batch.
   *
   * Accepts a single object or an array, like the notices ingest, because a
   * caller with one event should not have to wrap it.
   */
  app.post('/api/calendar/events', { bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
    const body = request.body;

    if (body === undefined || body === null) {
      return reply.code(400).send({
        error: 'INVALID_EVENT',
        message: 'Send an event object or an array of them.',
      });
    }

    const list = Array.isArray(body) ? body : [body];

    if (list.length === 0) {
      return reply.code(400).send({ error: 'INVALID_EVENT', message: 'Send at least one event.' });
    }

    if (list.length > MAX_BATCH) {
      return reply.code(413).send({
        error: 'BATCH_TOO_LARGE',
        message: `At most ${MAX_BATCH} events per request (got ${list.length}).`,
      });
    }

    const { events, errors } = parseCalendarEvents(list);

    if (errors.length > 0) return refuseInvalid(reply, errors, list.length);

    const { written, events: created } = insertEvents(db, events, { now: now(), idFactory });

    reply.header('cache-control', 'no-store');
    return reply.code(201).send({ written, events: created });
  });

  /**
   * PATCH /api/calendar/events/:id — edit a local event.
   *
   * A partial update: the patch is merged onto the stored event and the
   * result is validated as a whole, so a patch that moves only the end past
   * the start is caught (see `parseEventPatch`).
   */
  app.patch('/api/calendar/events/:id', { bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
    const { id } = request.params;

    // Checked BEFORE the lookup, so a feed id gets the explanation rather
    // than a 404 — the caller can see that event in the merged view, and
    // "not found" would be a lie that sends it looking for the wrong bug.
    if (!isLocalEventId(id)) return refuseForeignEvent(reply, id, 'edited');

    const existing = getEvent(db, id);
    if (!existing) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'No such local event.' });
    }

    let updated;
    try {
      updated = parseEventPatch(existing, request.body);
    } catch (error) {
      if (!(error instanceof CalendarValidationError)) throw error;
      return refuseInvalid(reply, [{ index: 0, field: error.field, message: error.message }], 1);
    }

    const saved = updateEvent(db, id, updated, { now: now() });

    reply.header('cache-control', 'no-store');
    return { event: saved };
  });

  /** DELETE /api/calendar/events/:id — remove a local event. */
  app.delete('/api/calendar/events/:id', async (request, reply) => {
    const { id } = request.params;

    if (!isLocalEventId(id)) return refuseForeignEvent(reply, id, 'deleted');

    if (!deleteEvent(db, id)) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'No such local event.' });
    }

    reply.header('cache-control', 'no-store');
    return { deleted: true, id };
  });
}
