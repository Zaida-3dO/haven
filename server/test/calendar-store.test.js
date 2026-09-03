/**
 * The local calendar store.
 *
 * The interesting behaviour here is the range query, which has to be correct
 * across two representations that do not compare naturally — an ISO instant
 * and a bare date — and has to use OVERLAP rather than "starts within", or it
 * drops exactly the multi-day events a dashboard most needs to show.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrate.js';
import {
  countEvents,
  deleteEvent,
  getEvent,
  insertEvents,
  isLocalEventId,
  listEvents,
  updateEvent,
} from '../src/db/calendar-store.js';
import { parseCalendarEvent } from '../src/calendar/event-envelope.js';

function freshDb(t) {
  const db = new Database(':memory:');
  migrate(db);
  t.after(() => db.close());
  return db;
}

/** Insert one validated event and return it. */
function add(db, input) {
  const { events } = insertEvents(db, [parseCalendarEvent(input)]);
  return events[0];
}

// ── Ids ──────────────────────────────────────────────────────────────────

test('a local id is recognisable, and an ICS id is not', () => {
  assert.equal(isLocalEventId('local:abc'), true);
  // The shape ics-parse.js produces: <feedId>:<uid>:<start>. The two
  // namespaces cannot collide, which is what lets the routes tell a
  // read-only refusal apart from a genuine 404.
  assert.equal(isLocalEventId('feed-1:uid-9:2026-06-12T09:00:00.000Z'), false);
  assert.equal(isLocalEventId(''), false);
  assert.equal(isLocalEventId(undefined), false);
});

test('an id is not derived from the title', (t) => {
  const db = freshDb(t);
  const event = add(db, { title: 'Divorce lawyer', start: '2026-06-12T09:00:00Z' });
  // An id ends up in a URL and in the DOM; a title is personal data.
  assert.ok(!event.id.toLowerCase().includes('divorce'));
  assert.ok(!event.id.toLowerCase().includes('lawyer'));
});

// ── Round trips ──────────────────────────────────────────────────────────

test('a timed event round-trips as an instant pair with no dates', (t) => {
  const db = freshDb(t);
  const created = add(db, {
    title: 'Dentist',
    start: '2026-06-12T09:00:00Z',
    end: '2026-06-12T09:30:00Z',
  });

  const read = getEvent(db, created.id);
  assert.equal(read.allDay, false);
  assert.equal(read.start, '2026-06-12T09:00:00.000Z');
  assert.equal(read.startDate, null);
  assert.equal(read.source, 'local');
});

test('an all-day event round-trips as a DATE, never an instant', (t) => {
  const db = freshDb(t);
  const created = add(db, { title: 'Birthday', allDay: true, startDate: '2026-06-12' });

  const read = getEvent(db, created.id);
  assert.equal(read.allDay, true);
  // The invariant the schema CHECK also holds: a date must not acquire a time.
  assert.equal(read.startDate, '2026-06-12');
  assert.equal(read.start, null);
  assert.equal(read.end, null);
});

test('an unknown id reads as null rather than throwing', (t) => {
  const db = freshDb(t);
  assert.equal(getEvent(db, 'local:nope'), null);
});

// ── The schema holds the invariant, not only the validator ───────────────

test('the schema refuses a row carrying both an instant and a date', (t) => {
  const db = freshDb(t);
  // A future writer that bypasses the envelope still cannot create the
  // ambiguous row — the CHECK constraint is the backstop.
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO calendar_events (id, title, all_day, start_at, end_at, start_date, end_date)
           VALUES ('local:bad', 'x', 1, '2026-06-12T09:00:00Z', '2026-06-12T10:00:00Z',
                   '2026-06-12', '2026-06-12')`
        )
        .run(),
    /CHECK constraint failed/
  );
});

test('the schema refuses an end before its start', (t) => {
  const db = freshDb(t);
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO calendar_events (id, title, all_day, start_at, end_at)
           VALUES ('local:bad', 'x', 0, '2026-06-12T10:00:00Z', '2026-06-12T09:00:00Z')`
        )
        .run(),
    /CHECK constraint failed/
  );
});

// ── Update and delete ────────────────────────────────────────────────────

test('an update replaces the whole row and bumps updated_at', (t) => {
  const db = freshDb(t);
  const created = add(db, { title: 'Old', start: '2026-06-12T09:00:00Z' });

  const updated = updateEvent(
    db,
    created.id,
    parseCalendarEvent({ title: 'New', start: '2026-06-13T09:00:00Z' }),
    { now: Date.parse('2026-06-02T00:00:00Z') }
  );

  assert.equal(updated.title, 'New');
  assert.equal(updated.start, '2026-06-13T09:00:00.000Z');
  assert.equal(updated.updatedAt, '2026-06-02T00:00:00.000Z');
});

test('updating an unknown id reports null rather than inserting', (t) => {
  const db = freshDb(t);
  const result = updateEvent(
    db,
    'local:nope',
    parseCalendarEvent({ title: 'x', start: '2026-06-12T09:00:00Z' })
  );
  assert.equal(result, null);
  assert.equal(countEvents(db), 0, 'a failed update must not create a row');
});

test('delete reports whether a row matched', (t) => {
  const db = freshDb(t);
  const created = add(db, { title: 'x', start: '2026-06-12T09:00:00Z' });

  assert.equal(deleteEvent(db, created.id), true);
  assert.equal(deleteEvent(db, created.id), false);
  assert.equal(countEvents(db), 0);
});

// ── The range query ──────────────────────────────────────────────────────

test('a range returns only what overlaps it', (t) => {
  const db = freshDb(t);
  add(db, { title: 'Before', start: '2026-05-01T09:00:00Z' });
  add(db, { title: 'Inside', start: '2026-06-15T09:00:00Z' });
  add(db, { title: 'After', start: '2026-07-01T09:00:00Z' });

  const found = listEvents(db, {
    from: '2026-06-01T00:00:00.000Z',
    to: '2026-06-30T23:59:59.999Z',
  });

  assert.deepEqual(
    found.map((event) => event.title),
    ['Inside']
  );
});

test('an event straddling the window start is included', (t) => {
  const db = freshDb(t);
  add(db, {
    title: 'Straddles the start',
    start: '2026-05-30T09:00:00Z',
    end: '2026-06-02T17:00:00Z',
  });

  const found = listEvents(db, {
    from: '2026-06-01T00:00:00.000Z',
    to: '2026-06-30T23:59:59.999Z',
  });

  // "Starts within" would drop this. It is happening during the window.
  assert.equal(found.length, 1);
});

test('an all-day event on the window’s last day is included', (t) => {
  const db = freshDb(t);
  add(db, { title: 'Last day', allDay: true, startDate: '2026-06-30' });

  const found = listEvents(db, {
    from: '2026-06-01T00:00:00.000Z',
    to: '2026-06-30T23:59:59.999Z',
  });

  // The comparison has to work across representations: a bare date column
  // against an ISO instant bound. Getting this wrong drops every all-day
  // event at a window boundary.
  assert.equal(found.length, 1, 'an all-day event at the boundary was dropped');
});

test('a multi-day all-day event spanning the window is included', (t) => {
  const db = freshDb(t);
  add(db, { title: 'Conference', allDay: true, startDate: '2026-05-28', endDate: '2026-06-03' });

  const found = listEvents(db, {
    from: '2026-06-01T00:00:00.000Z',
    to: '2026-06-30T23:59:59.999Z',
  });
  assert.equal(found.length, 1);
});

test('results are chronological, all-day first within a day', (t) => {
  const db = freshDb(t);
  add(db, { title: 'Afternoon', start: '2026-06-12T15:00:00Z' });
  add(db, { title: 'Morning', start: '2026-06-12T09:00:00Z' });
  add(db, { title: 'All day', allDay: true, startDate: '2026-06-12' });

  const found = listEvents(db, {});
  assert.deepEqual(
    found.map((event) => event.title),
    ['All day', 'Morning', 'Afternoon']
  );
});

test('an absent range returns everything', (t) => {
  const db = freshDb(t);
  add(db, { title: 'a', start: '2020-01-01T09:00:00Z' });
  add(db, { title: 'b', start: '2040-01-01T09:00:00Z' });
  assert.equal(listEvents(db, {}).length, 2);
});

test('a batch inserts atomically', (t) => {
  const db = freshDb(t);
  const { written, events } = insertEvents(db, [
    parseCalendarEvent({ title: 'one', start: '2026-06-12T09:00:00Z' }),
    parseCalendarEvent({ title: 'two', start: '2026-06-13T09:00:00Z' }),
  ]);

  assert.equal(written, 2);
  assert.equal(events.length, 2);
  assert.equal(countEvents(db), 2);
  // Ids are distinct even within one batch.
  assert.notEqual(events[0].id, events[1].id);
});
