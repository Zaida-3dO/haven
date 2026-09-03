/**
 * The local calendar-event envelope.
 *
 * Everything here is about the one rule the envelope exists to hold: a write
 * that arrives from outside is REJECTED when it is wrong, never repaired. A
 * calendar that quietly guesses what "next tuesday" meant shows the wrong day
 * and nobody finds out until they miss something.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CalendarValidationError,
  LIMITS,
  LOCAL_SOURCE,
  MAX_DURATION_MS,
  parseCalendarEvent,
  parseCalendarEvents,
  parseEventPatch,
} from '../src/calendar/event-envelope.js';

/** Assert a parse fails, and fails naming the field a caller must fix. */
function rejects(input, field) {
  assert.throws(
    () => parseCalendarEvent(input),
    (error) => {
      assert.ok(
        error instanceof CalendarValidationError,
        `expected a CalendarValidationError, got ${error?.name}`
      );
      assert.equal(error.field, field, `expected the error to name "${field}"`);
      return true;
    }
  );
}

// ── The happy shapes ─────────────────────────────────────────────────────

test('a timed event normalises to a UTC instant pair', () => {
  const event = parseCalendarEvent({
    title: '  Dentist  ',
    start: '2026-06-12T09:00:00+01:00',
    end: '2026-06-12T09:30:00+01:00',
    location: ' Chair 2 ',
  });

  assert.equal(event.title, 'Dentist');
  assert.equal(event.allDay, false);
  // Normalised to UTC on ingest — the whole reason a range query in SQL is
  // correct across callers that send different offsets.
  assert.equal(event.start, '2026-06-12T08:00:00.000Z');
  assert.equal(event.end, '2026-06-12T08:30:00.000Z');
  assert.equal(event.startDate, null);
  assert.equal(event.endDate, null);
  assert.equal(event.location, 'Chair 2');
});

test('an all-day event keeps its DATE and is given no instant', () => {
  const event = parseCalendarEvent({
    title: 'Birthday',
    allDay: true,
    startDate: '2026-06-12',
  });

  assert.equal(event.allDay, true);
  // The load-bearing assertion: a date must NOT become an instant. Storing
  // 2026-06-12 as a timestamp renders it on the 11th for any viewer west of
  // UTC — the trap ics-parse.js documents at length.
  assert.equal(event.startDate, '2026-06-12');
  assert.equal(event.start, null);
  assert.equal(event.end, null);
  // An absent end means a single-day event, inclusive.
  assert.equal(event.endDate, '2026-06-12');
});

test('an all-day event may be given its dates as start/end', () => {
  const event = parseCalendarEvent({
    title: 'Trip',
    allDay: true,
    start: '2026-06-12',
    end: '2026-06-15',
  });
  assert.equal(event.startDate, '2026-06-12');
  assert.equal(event.endDate, '2026-06-15');
});

test('a timed event with no end is a point in time, not an error', () => {
  const event = parseCalendarEvent({ title: 'Call Sam', start: '2026-06-12T15:00:00Z' });
  assert.equal(event.end, event.start);
});

test('unknown keys are dropped rather than rejected on create', () => {
  const event = parseCalendarEvent({
    title: 'Standup',
    start: '2026-06-12T09:00:00Z',
    colour: 'blue',
    attendees: ['someone'],
  });
  assert.deepEqual(Object.keys(event).sort(), [
    'allDay',
    'description',
    'end',
    'endDate',
    'location',
    'start',
    'startDate',
    'title',
  ]);
});

// ── Rejection, and the message that comes with it ────────────────────────

test('a non-ISO start is rejected, and the message quotes what was sent', () => {
  assert.throws(
    () => parseCalendarEvent({ title: 'x', start: 'next tuesday' }),
    (error) => {
      assert.equal(error.field, 'start');
      // Rule 2 of the envelope: the error has to be fixable by the program
      // that sent it, which means naming the field AND the bad value.
      assert.match(error.message, /start/);
      assert.match(error.message, /next tuesday/);
      return true;
    }
  );
});

test('Date.parse leniency is not inherited', () => {
  // Date.parse accepts this; ISO-8601 does not, and it is ambiguous across
  // locales. Accepting it would put an event on the wrong day silently.
  assert.equal(Number.isFinite(Date.parse('March 2 2026')), true);
  rejects({ title: 'x', start: 'March 2 2026' }, 'start');
});

test('a date that matches the shape but does not exist is rejected', () => {
  rejects({ title: 'x', allDay: true, startDate: '2026-02-31' }, 'startDate');
});

test('an end before its start is rejected', () => {
  rejects({ title: 'x', start: '2026-06-12T10:00:00Z', end: '2026-06-12T09:00:00Z' }, 'end');
  rejects({ title: 'x', allDay: true, startDate: '2026-06-12', endDate: '2026-06-11' }, 'endDate');
});

test('an absurdly long event is rejected rather than sitting in every query', () => {
  const start = '2026-01-01T00:00:00Z';
  const end = new Date(Date.parse(start) + MAX_DURATION_MS + 60_000).toISOString();
  rejects({ title: 'x', start, end }, 'end');
});

test('a missing or empty title is rejected', () => {
  rejects({ start: '2026-06-12T09:00:00Z' }, 'title');
  rejects({ title: '   ', start: '2026-06-12T09:00:00Z' }, 'title');
});

test('an over-long field is rejected with its limit', () => {
  assert.throws(
    () =>
      parseCalendarEvent({
        title: 'x'.repeat(LIMITS.title + 1),
        start: '2026-06-12T09:00:00Z',
      }),
    (error) => {
      assert.equal(error.field, 'title');
      assert.match(error.message, new RegExp(String(LIMITS.title)));
      return true;
    }
  );
});

test('allDay must be a boolean when present', () => {
  rejects({ title: 'x', allDay: 'yes', startDate: '2026-06-12' }, 'allDay');
});

test('date fields on a timed event are refused rather than silently ignored', () => {
  // Sending startDate without allDay is a caller that thinks it is creating an
  // all-day event. Dropping the key would create a timed one at a time it
  // never chose.
  rejects({ title: 'x', startDate: '2026-06-12' }, 'startDate');
});

// ── `source` is not a caller-supplied field ──────────────────────────────

test('a caller cannot claim a source, which is what keeps it a boundary', () => {
  // The notices ingest was found trusting a caller-supplied `source` as a
  // privilege boundary. Here `source` decides whether an event is editable,
  // so a caller must not be able to set it — including to a feed id.
  assert.throws(
    () => parseCalendarEvent({ title: 'x', start: '2026-06-12T09:00:00Z', source: 'feed-1' }),
    (error) => {
      assert.equal(error.field, 'source');
      assert.match(error.message, /read-only/);
      return true;
    }
  );
});

test('an explicit source of "local" is allowed, since it changes nothing', () => {
  const event = parseCalendarEvent({
    title: 'x',
    start: '2026-06-12T09:00:00Z',
    source: LOCAL_SOURCE,
  });
  assert.equal(event.title, 'x');
});

// ── Batches report every bad entry ───────────────────────────────────────

test('a batch reports EVERY bad entry, not just the first', () => {
  const { events, errors } = parseCalendarEvents([
    { title: 'ok', start: '2026-06-12T09:00:00Z' },
    { title: '', start: '2026-06-12T09:00:00Z' },
    { title: 'bad start', start: 'whenever' },
    { title: 'also ok', start: '2026-06-13T09:00:00Z' },
  ]);

  assert.equal(events.length, 2);
  assert.equal(errors.length, 2, 'both bad entries should be reported in one round trip');
  assert.deepEqual(
    errors.map((e) => [e.index, e.field]),
    [
      [1, 'title'],
      [2, 'start'],
    ]
  );
});

test('a single object is accepted as a batch of one', () => {
  const { events, errors } = parseCalendarEvents({ title: 'x', start: '2026-06-12T09:00:00Z' });
  assert.equal(events.length, 1);
  assert.equal(errors.length, 0);
});

// ── Patching validates the RESULT, not the fields in isolation ───────────

const STORED = Object.freeze({
  title: 'Dentist',
  allDay: false,
  start: '2026-06-12T09:00:00.000Z',
  end: '2026-06-12T09:30:00.000Z',
  startDate: null,
  endDate: null,
  description: null,
  location: null,
});

test('a patch merges onto the stored event', () => {
  const patched = parseEventPatch(STORED, { title: 'Hygienist' });
  assert.equal(patched.title, 'Hygienist');
  // Untouched fields survive.
  assert.equal(patched.start, STORED.start);
  assert.equal(patched.end, STORED.end);
});

test('a patch that moves only the end past the start is caught', () => {
  // The whole reason the patch is validated as a merged WHOLE: this body
  // mentions neither `start` nor anything obviously wrong on its own.
  assert.throws(
    () => parseEventPatch(STORED, { end: '2026-06-12T08:00:00Z' }),
    (error) => {
      assert.equal(error.field, 'end');
      return true;
    }
  );
});

test('an empty patch is refused rather than answering 200 to a no-op', () => {
  assert.throws(() => parseEventPatch(STORED, {}), CalendarValidationError);
});

test('an unknown field in a patch is refused, not dropped', () => {
  // On create an unknown key is dropped; on patch it must not be, because a
  // patch is a statement about what should change and `{"titel": "..."}`
  // silently doing nothing is worse than an error.
  assert.throws(
    () => parseEventPatch(STORED, { titel: 'typo' }),
    (error) => {
      assert.equal(error.field, 'titel');
      return true;
    }
  );
});

test('flipping a timed event to all-day requires the dates it now needs', () => {
  // Inheriting `start` as a date would be a repair, and the wrong one.
  assert.throws(() => parseEventPatch(STORED, { allDay: true }), CalendarValidationError);

  const flipped = parseEventPatch(STORED, { allDay: true, startDate: '2026-06-12' });
  assert.equal(flipped.allDay, true);
  assert.equal(flipped.startDate, '2026-06-12');
  assert.equal(flipped.start, null);
});
