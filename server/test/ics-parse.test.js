import { test } from 'node:test';
import assert from 'node:assert/strict';

import ICAL from 'ical.js';

import { parseIcs, sortEvents, IcsParseError } from '../src/connectors/ics-parse.js';
import {
  SAMPLE_ICS,
  OVERRIDE_ICS,
  PARTIALLY_BROKEN_ICS,
  EMPTY_ICS,
  UNBOUNDED_ICS,
} from './helpers/ics-fixtures.js';

const FEED = { id: 'feed-1', name: 'Calendar' };

/** A window wide enough to hold every fixture event. */
const WINDOW = {
  windowStart: new Date('2026-05-01T00:00:00Z'),
  windowEnd: new Date('2026-08-01T00:00:00Z'),
};

const parse = (ics, window = WINDOW) => parseIcs(ics, FEED, window);
const byTitle = (events, title) => events.filter((e) => e.title === title);

test('a timed event carries the instant its VTIMEZONE implies, not a naive one', () => {
  const events = parse(SAMPLE_ICS);
  const [dentist] = byTitle(events, 'Dentist appointment');

  assert.ok(dentist, 'expected the timed fixture event');
  assert.equal(dentist.allDay, false);
  // 09:00 Europe/London in June is BST (+01:00), so 08:00Z. A parser that
  // ignored VTIMEZONE would produce 09:00Z and this would read 09:00.
  assert.equal(dentist.start, '2026-06-10T08:00:00.000Z');
  assert.equal(dentist.end, '2026-06-10T08:45:00.000Z');
  assert.equal(dentist.location, 'High Street');
});

/**
 * Guards the VTIMEZONE registration step specifically.
 *
 * Worth explaining, because the obvious version of this test does not work.
 * When a `TZID` cannot be resolved, `ical.js` falls back to treating the time
 * as FLOATING — i.e. local to whatever machine is running. On a host already
 * in Europe/London that fallback coincidentally produces the right instant,
 * so an assertion on `start` alone passes even with registration removed, and
 * would then fail only on a UTC CI runner. (Verified: with registration
 * disabled this fixture yields 08:00Z under `TZ=Europe/London` and 09:00Z
 * under `TZ=UTC`.)
 *
 * So this asserts on the resolved ZONE, which is `floating` exactly when
 * registration did not happen and is host-independent.
 */
test('the feed’s VTIMEZONE is registered, so a TZID resolves rather than floating', () => {
  const comp = new ICAL.Component(ICAL.parse(SAMPLE_ICS));
  const tzids = comp.getAllSubcomponents('vtimezone').map((vt) => new ICAL.Timezone(vt).tzid);
  assert.ok(tzids.includes('Europe/London'), 'fixture should define its zone');

  // parseIcs registers the feed's zones as a side effect.
  parse(SAMPLE_ICS);
  assert.ok(
    ICAL.TimezoneService.has('Europe/London'),
    'parseIcs must register the feed’s VTIMEZONE, or every TZID silently floats'
  );

  const vevent = comp
    .getAllSubcomponents('vevent')
    .find((v) => v.getFirstPropertyValue('summary') === 'Dentist appointment');
  const resolved = new ICAL.Event(vevent).startDate;
  assert.notEqual(resolved.zone.tzid, 'floating', 'the TZID must resolve to a real zone');
  assert.equal(resolved.zone.tzid, 'Europe/London');
});

test('an all-day event carries a date string and NO instant', () => {
  const [holiday] = byTitle(parse(SAMPLE_ICS), 'Bank holiday');

  assert.ok(holiday);
  assert.equal(holiday.allDay, true);
  assert.equal(holiday.startDate, '2026-06-12');
  // The whole point: an instant would be 2026-06-11T23:00Z from a BST host
  // and would render the event a day early for any viewer at or west of UTC.
  assert.equal(holiday.start, null, 'an all-day event must not carry an instant');
  assert.equal(holiday.end, null);
});

test("a single-day all-day event ends on the day it covers, not DTEND's exclusive date", () => {
  const [holiday] = byTitle(parse(SAMPLE_ICS), 'Bank holiday');
  // DTEND is 20260613 and is EXCLUSIVE per RFC 5545. Storing it verbatim
  // would make every one-day event look like it spans two.
  assert.equal(holiday.endDate, '2026-06-12');
});

test('a multi-day all-day event covers its true last day', () => {
  const [trip] = byTitle(parse(SAMPLE_ICS), 'Trip away');
  assert.equal(trip.startDate, '2026-06-13');
  // DTSTART 13th, DTEND 16th exclusive => covers the 13th, 14th and 15th.
  assert.equal(trip.endDate, '2026-06-15');
});

test('a recurring event expands, and EXDATE removes the excluded occurrence', () => {
  const syncs = byTitle(parse(SAMPLE_ICS), 'Team sync');
  const days = syncs.map((e) => e.start.slice(0, 10));

  // COUNT=5 from 2026-06-01 weekly = 1, 8, 15, 22, 29 — minus the excluded
  // 15th.
  assert.deepEqual(days, ['2026-06-01', '2026-06-08', '2026-06-22', '2026-06-29']);
  assert.ok(!days.includes('2026-06-15'), 'EXDATE occurrence must not appear');
});

test('each occurrence of a series gets its own id', () => {
  const ids = byTitle(parse(SAMPLE_ICS), 'Team sync').map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'occurrence ids must be unique');
});

test('a RECURRENCE-ID override replaces that occurrence and is not duplicated', () => {
  const events = parse(OVERRIDE_ICS);

  assert.equal(events.length, 3, 'three occurrences, the middle one overridden');

  const moved = events.filter((e) => e.title === 'Weekly review (moved)');
  assert.equal(moved.length, 1, 'the override appears exactly once');
  // Moved from 14:00 to 16:30 London = 15:30Z in June (BST).
  assert.equal(moved[0].start, '2026-06-08T15:30:00.000Z');

  const originals = events.filter((e) => e.title === 'Weekly review');
  assert.equal(originals.length, 2, 'the overridden slot must not also appear unmodified');
  assert.ok(!originals.some((e) => e.start.startsWith('2026-06-08')));
});

test('events outside the window are excluded', () => {
  const events = parseIcs(SAMPLE_ICS, FEED, {
    windowStart: new Date('2026-06-20T00:00:00Z'),
    windowEnd: new Date('2026-07-01T00:00:00Z'),
  });

  assert.equal(byTitle(events, 'Dentist appointment').length, 0, '10 June is before the window');
  assert.deepEqual(
    byTitle(events, 'Team sync').map((e) => e.start.slice(0, 10)),
    ['2026-06-22', '2026-06-29']
  );
});

test('an event still running when the window opens is kept', () => {
  // The trip covers 13-15 June; a window opening on the 14th is mid-trip.
  const events = parseIcs(SAMPLE_ICS, FEED, {
    windowStart: new Date('2026-06-14T00:00:00Z'),
    windowEnd: new Date('2026-06-20T00:00:00Z'),
  });
  assert.equal(byTitle(events, 'Trip away').length, 1, 'an in-progress event must not vanish');
});

test('one malformed VEVENT does not discard the rest of the feed', () => {
  const events = parse(PARTIALLY_BROKEN_ICS);
  assert.equal(byTitle(events, 'Perfectly fine event').length, 1);
});

test('a valid calendar with no events parses to an empty list, not an error', () => {
  assert.deepEqual(parse(EMPTY_ICS), []);
});

test('an unbounded recurrence rule is capped rather than expanded forever', () => {
  const events = parseIcs(UNBOUNDED_ICS, FEED, {
    windowStart: new Date('2026-06-01T00:00:00Z'),
    // A ten-year window against FREQ=DAILY: ~3,650 occurrences uncapped.
    windowEnd: new Date('2036-06-01T00:00:00Z'),
  });
  assert.ok(events.length > 0, 'the series should still produce occurrences');
  assert.ok(events.length <= 750, `expected the cap to bound expansion, got ${events.length}`);
});

test('unparseable input throws IcsParseError', () => {
  assert.throws(() => parse('this is not a calendar'), IcsParseError);
});

test('empty input throws IcsParseError', () => {
  assert.throws(() => parse('   '), IcsParseError);
});

test('the parse error never quotes the feed body back', () => {
  // The message is built from the error NAME only, so a feed whose contents
  // are sensitive cannot leak through a parse failure.
  try {
    parse('BEGIN:VCALENDAR\r\nSECRET-LOOKING-TOKEN:hunter2\r\n');
    // Some malformed inputs parse to zero events rather than throwing; that
    // is fine, the assertion only applies when it throws.
  } catch (error) {
    assert.ok(!error.message.includes('hunter2'), 'must not echo feed content');
  }
});

test('sortEvents puts all-day events ahead of timed ones on the same day', () => {
  const sorted = sortEvents([
    { allDay: false, start: '2026-06-12T09:00:00.000Z', startDate: null, title: 'Timed' },
    { allDay: true, start: null, startDate: '2026-06-12', title: 'All day' },
  ]);
  assert.deepEqual(
    sorted.map((e) => e.title),
    ['All day', 'Timed']
  );
});

test('sortEvents orders across days chronologically', () => {
  const sorted = sortEvents([
    { allDay: false, start: '2026-06-14T09:00:00.000Z', startDate: null, title: 'Later' },
    { allDay: true, start: null, startDate: '2026-06-11', title: 'Earlier all-day' },
    { allDay: false, start: '2026-06-12T09:00:00.000Z', startDate: null, title: 'Middle' },
  ]);
  assert.deepEqual(
    sorted.map((e) => e.title),
    ['Earlier all-day', 'Middle', 'Later']
  );
});
