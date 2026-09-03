/**
 * Storage for Haven-local calendar events.
 *
 * The ICS feeds are read-only — a secret iCal address grants read access and
 * nothing else — so an event created through the API has to live somewhere of
 * its own. This is that somewhere, and the separation is deliberate: "can
 * this event be edited?" is answered by *which store it came from*, not by a
 * flag on a row that a caller could set.
 *
 * ## The two representations
 *
 * A timed event is an instant; an all-day event is a date. They are stored in
 * different columns and never converted into each other — see
 * `005-calendar-events.sql` and the long comment in `ics-parse.js` for why
 * turning `2026-06-12` into a `Date` renders it on the 11th for half the
 * world. Everything here preserves that split.
 *
 * ## Ids
 *
 * Server-generated (`local:<uuid>`), never derived from the title. An id
 * appears in a URL and in the DOM; a title is personal data. The `local:`
 * prefix makes an id self-describing, so a caller holding one it got from the
 * merged view can tell before it tries whether a PATCH is going to work.
 */

import { randomUUID } from 'node:crypto';

import { LOCAL_SOURCE } from '../calendar/event-envelope.js';

/** Prefix on every local event id. Also how `isLocalEventId` recognises one. */
export const LOCAL_ID_PREFIX = 'local:';

/** Ceiling on one range query, so a wide `from`/`to` cannot exhaust memory. */
export const MAX_EVENTS = 1000;

const iso = (ms) => new Date(ms).toISOString();

/**
 * Does this id belong to the local store?
 *
 * ICS-sourced ids are `<feedId>:<uid>:<start>` (see `ics-parse.js`), so the
 * two namespaces cannot collide. This is what lets the write routes tell a
 * "you cannot edit a feed event" refusal apart from a plain 404 — a caller
 * who gets 404 for a real event it can see in the merged view would conclude
 * the read endpoint was lying to it.
 */
export function isLocalEventId(id) {
  return typeof id === 'string' && id.startsWith(LOCAL_ID_PREFIX);
}

/** DB row → the same normalised shape `ics-parse.js` emits, plus `source`. */
function toEvent(row) {
  const allDay = row.all_day === 1;
  return {
    id: row.id,
    title: row.title,
    allDay,
    start: allDay ? null : row.start_at,
    end: allDay ? null : row.end_at,
    startDate: allDay ? row.start_date : null,
    endDate: allDay ? row.end_date : null,
    description: row.description ?? null,
    location: row.location ?? null,
    /**
     * `source: 'local'` is the whole contract with a calling agent: it is how
     * the client knows this event can be edited, and how the widget knows to
     * mark it as Haven's own rather than a feed's.
     */
    source: LOCAL_SOURCE,
    // Feed attribution, mirrored so a merged list is uniform. Local events
    // are their own "feed" as far as the widget's grouping is concerned.
    feedId: LOCAL_SOURCE,
    feedName: 'Haven',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The columns an insert or update writes, from a validated envelope. */
function toRow(event) {
  return {
    title: event.title,
    description: event.description,
    location: event.location,
    all_day: event.allDay ? 1 : 0,
    start_at: event.allDay ? null : event.start,
    end_at: event.allDay ? null : event.end,
    start_date: event.allDay ? event.startDate : null,
    end_date: event.allDay ? event.endDate : null,
  };
}

/**
 * Insert a batch of validated events, in one transaction.
 *
 * All-or-nothing, like the notices ingest: a batch that fails part-way leaves
 * the sender unable to tell what landed.
 *
 * @param {object} db
 * @param {object[]} events envelopes from `parseCalendarEvents`
 * @returns {{ written: number, events: object[] }}
 */
export function insertEvents(db, events, { now = Date.now(), idFactory = randomUUID } = {}) {
  const stamp = iso(now);

  const insert = db.prepare(`
    INSERT INTO calendar_events (
      id, title, description, location, all_day,
      start_at, end_at, start_date, end_date, created_at, updated_at
    ) VALUES (
      @id, @title, @description, @location, @all_day,
      @start_at, @end_at, @start_date, @end_date, @stamp, @stamp
    )
  `);

  const ids = [];

  const run = db.transaction(() => {
    for (const event of events) {
      const id = `${LOCAL_ID_PREFIX}${idFactory()}`;
      insert.run({ id, ...toRow(event), stamp });
      ids.push(id);
    }
  });

  run();

  return { written: ids.length, events: ids.map((id) => getEvent(db, id)) };
}

/** One local event by id, or `null`. */
export function getEvent(db, id) {
  const row = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  return row ? toEvent(row) : null;
}

/**
 * Replace a local event with a validated envelope.
 *
 * A full replace rather than a column-wise update: the envelope has already
 * merged the patch onto the stored event and validated the RESULT, so writing
 * anything less than the whole row would let the two disagree.
 *
 * @returns {object|null} the updated event, or `null` if no such row
 */
export function updateEvent(db, id, event, { now = Date.now() } = {}) {
  const result = db
    .prepare(
      `UPDATE calendar_events
          SET title = @title, description = @description, location = @location,
              all_day = @all_day, start_at = @start_at, end_at = @end_at,
              start_date = @start_date, end_date = @end_date, updated_at = @stamp
        WHERE id = @id`
    )
    .run({ id, ...toRow(event), stamp: iso(now) });

  return result.changes > 0 ? getEvent(db, id) : null;
}

/**
 * Delete a local event.
 *
 * NOT idempotent-by-pretending: a delete of an unknown id reports `false` so
 * the route can answer 404. A caller deleting something that is not there has
 * a stale id, and telling it so is more useful than a cheerful 204.
 *
 * @returns {boolean} whether a row matched
 */
export function deleteEvent(db, id) {
  return db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id).changes > 0;
}

/**
 * Every local event overlapping `[from, to]`, soonest first.
 *
 * OVERLAPPING, not "starting within" — an event that began yesterday and runs
 * until tomorrow is happening today, and a range query that missed it would
 * drop exactly the events a dashboard most needs to show. So the test is
 * `end >= from AND start <= to`.
 *
 * The comparison works across both representations because a date string and
 * an ISO instant that share a `YYYY-MM-DD` prefix compare correctly for the
 * purposes of a day-granular window: `'2026-06-12' <= '2026-06-12T09:00:00Z'`
 * is true, which is the answer we want at the boundary (an all-day event on
 * the 12th overlaps a window opening at 09:00 on the 12th). The window bounds
 * are therefore normalised to full ISO instants by the caller and compared
 * against whichever column is populated.
 *
 * @param {object} db
 * @param {{ from?: string, to?: string, limit?: number }} options ISO bounds
 */
export function listEvents(db, { from = null, to = null, limit = MAX_EVENTS } = {}) {
  const rows = db
    .prepare(
      `
      SELECT * FROM calendar_events
       WHERE (@from IS NULL OR COALESCE(end_at, end_date || 'T23:59:59.999Z') >= @from)
         AND (@to   IS NULL OR COALESCE(start_at, start_date) <= @to)
       ORDER BY COALESCE(start_at, start_date) ASC,
                all_day DESC,
                title ASC
       LIMIT @limit
    `
    )
    .all({ from, to, limit: Math.min(limit, MAX_EVENTS) });

  return rows.map(toEvent);
}

/** Every local event, ignoring any window. A test and ops seam. */
export function countEvents(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n;
}
