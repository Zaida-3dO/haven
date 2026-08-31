import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupByDay,
  dayKeyFor,
  localDayKey,
  parseDayKey,
  daysBetween,
  dayLabel,
  formatTimeRange,
  isMultiDay,
  isPast,
  toSearchEntries,
} from '../src/widgets/calendar/group.js';

/**
 * Run under several timezones via `npm run test:tz --workspace=web`, because
 * the bugs this module exists to prevent are invisible in most zones.
 *
 * Two traps are worth naming, because both were hit while writing this file:
 *
 * 1. A fixture built with `new Date(2026, 5, 10, 9, 0).toISOString()` is a
 *    LOCAL-time constructor, so its local day and its UTC day coincide by
 *    construction. Assertions on such a fixture cannot distinguish "bucketed
 *    by local day" from "bucketed by `start.slice(0, 10)`", and mutation
 *    testing confirmed they do not. The tests below that guard local-day
 *    handling therefore use EXPLICIT UTC instants near midnight, where the
 *    two answers genuinely differ.
 *
 * 2. On Windows/Git Bash a `TZ=... node` prefix does not reach Node at all.
 *    `scripts/test-timezones.mjs` passes `TZ` through a spawned child's env
 *    instead, and asserts it took effect before trusting the result.
 */

/** The offset, in hours, the host running these tests is at for a date. */
const offsetHours = (iso) => -new Date(iso).getTimezoneOffset() / 60;

const timed = (start, overrides = {}) => ({
  id: `timed-${start}`,
  title: 'Timed event',
  allDay: false,
  start,
  end: null,
  startDate: null,
  endDate: null,
  feedId: 'feed-1',
  feedName: 'Calendar',
  location: null,
  ...overrides,
});

const allDay = (startDate, endDate = startDate, overrides = {}) => ({
  id: `allday-${startDate}`,
  title: 'All-day event',
  allDay: true,
  start: null,
  end: null,
  startDate,
  endDate,
  feedId: 'feed-1',
  feedName: 'Calendar',
  location: null,
  ...overrides,
});

// ── The date primitives ──────────────────────────────────────────────────

test('parseDayKey builds a LOCAL midnight, not a UTC one', () => {
  const date = parseDayKey('2026-06-12');
  // `new Date('2026-06-12')` would be UTC midnight and would report the 11th
  // for any viewer west of UTC. The local-components form cannot.
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 5);
  assert.equal(date.getDate(), 12);
  assert.equal(date.getHours(), 0, 'must be local midnight');
  assert.equal(date.getMinutes(), 0);
});

test('localDayKey round-trips through parseDayKey', () => {
  for (const key of ['2026-01-01', '2026-06-12', '2026-12-31']) {
    assert.equal(localDayKey(parseDayKey(key)), key);
  }
});

test('an all-day event keeps its date string exactly', () => {
  // The single most important assertion in this file: the date must survive
  // untouched, never going through a Date and back.
  assert.equal(dayKeyFor(allDay('2026-06-12')), '2026-06-12');
});

test('a timed event is bucketed by the VIEWER’s local day, not the UTC day', () => {
  // 23:30Z on the 10th. East of UTC that is already the 11th locally; west of
  // UTC it is still the 10th. Either way the answer must be the LOCAL day,
  // and `start.slice(0, 10)` (which is always '2026-06-10') is wrong in every
  // zone ahead of UTC.
  const iso = '2026-06-10T23:30:00.000Z';
  const event = timed(iso);
  const local = new Date(iso);

  assert.equal(dayKeyFor(event), localDayKey(local));

  // Make the distinction explicit rather than trusting the helper: in any
  // zone ahead of UTC this event belongs to the 11th, not the 10th.
  if (offsetHours(iso) > 0.5) {
    assert.equal(dayKeyFor(event), '2026-06-11');
    assert.notEqual(dayKeyFor(event), iso.slice(0, 10));
  }
  // And in any zone behind UTC, 00:30Z on the 11th belongs to the 10th.
  const earlyIso = '2026-06-11T00:30:00.000Z';
  if (offsetHours(earlyIso) < -0.5) {
    assert.equal(dayKeyFor(timed(earlyIso)), '2026-06-10');
    assert.notEqual(dayKeyFor(timed(earlyIso)), earlyIso.slice(0, 10));
  }
});

test('an all-day date is NEVER reinterpreted through the viewer’s zone', () => {
  // The bug this guards: `new Date('2026-06-12')` is UTC midnight, so reading
  // its LOCAL date west of UTC yields the 11th and the event renders a day
  // early. The date string must survive untouched in every zone.
  for (const key of ['2026-01-01', '2026-06-12', '2026-12-31']) {
    assert.equal(
      dayKeyFor(allDay(key)),
      key,
      `an all-day event must stay on ${key} regardless of viewer timezone`
    );
  }

  // Belt and braces: prove the naive implementation really would differ here,
  // so this test cannot quietly become a tautology on some future host.
  const naive = localDayKey(new Date('2026-06-12'));
  if (offsetHours('2026-06-12T00:00:00.000Z') < 0) {
    assert.notEqual(naive, '2026-06-12', 'sanity: west of UTC the naive form shifts');
  }
});

test('daysBetween counts whole local days across a DST boundary', () => {
  // The UK springs forward on 2026-03-29. A naive (t2-t1)/86400000 without
  // rounding returns 0.958… here and floors to 0.
  assert.equal(daysBetween('2026-03-28', '2026-03-29'), 1);
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2);
  // And back again in October.
  assert.equal(daysBetween('2026-10-24', '2026-10-25'), 1);
});

// ── Labels ──────────────────────────────────────────────────────────────

test('today, tomorrow and yesterday are named rather than dated', () => {
  const now = new Date(2026, 5, 10, 9, 0, 0);
  assert.equal(dayLabel('2026-06-10', now), 'Today');
  assert.equal(dayLabel('2026-06-11', now), 'Tomorrow');
  assert.equal(dayLabel('2026-06-09', now), 'Yesterday');
});

test('a day inside the coming week is named by weekday', () => {
  const now = new Date(2026, 5, 10, 9, 0, 0);
  const label = dayLabel('2026-06-13', now, { locale: 'en-GB' });
  assert.equal(label, 'Saturday');
});

test('a day beyond the coming week carries a date', () => {
  const now = new Date(2026, 5, 10, 9, 0, 0);
  const label = dayLabel('2026-07-01', now, { locale: 'en-GB' });
  assert.match(label, /Jul/);
  assert.ok(!['Today', 'Tomorrow', 'Yesterday'].includes(label));
});

// ── Grouping ────────────────────────────────────────────────────────────

test('events group by day in chronological order', () => {
  const now = new Date(2026, 5, 10, 8, 0, 0);
  const groups = groupByDay(
    [
      timed(new Date(2026, 5, 12, 9, 0).toISOString(), { title: 'Later' }),
      timed(new Date(2026, 5, 10, 15, 0).toISOString(), { title: 'Today PM' }),
      timed(new Date(2026, 5, 11, 9, 0).toISOString(), { title: 'Tomorrow' }),
    ],
    { now }
  );

  assert.deepEqual(
    groups.map((g) => g.label),
    ['Today', 'Tomorrow', 'Friday']
  );
});

test('an event near midnight groups under the local day it falls in', () => {
  // "now" is fixed at local noon on the 10th; the event is at 23:30Z, which
  // is a different calendar day depending on the viewer. Grouping must agree
  // with the viewer's clock, not with UTC.
  const now = new Date(2026, 5, 10, 12, 0, 0);
  const iso = '2026-06-10T23:30:00.000Z';
  const expectedDay = localDayKey(new Date(iso));

  const groups = groupByDay([timed(iso, { title: 'Late one' })], { now });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].dayKey, expectedDay);

  // In a zone ahead of UTC this must land on Tomorrow, not Today — which is
  // precisely what a `slice(0, 10)` implementation would get wrong.
  if (offsetHours(iso) > 0.5) {
    assert.equal(groups[0].label, 'Tomorrow');
    assert.equal(groups[0].isToday, false);
  }
});

test('an all-day event groups on its own date in every timezone', () => {
  const now = new Date(2026, 5, 10, 12, 0, 0);
  const groups = groupByDay([allDay('2026-06-12', '2026-06-12', { title: 'Fixed day' })], { now });

  assert.equal(groups.length, 1);
  // Not "the 11th", which is what reinterpreting the date as a UTC instant
  // would produce for any viewer west of UTC.
  assert.equal(groups[0].dayKey, '2026-06-12');
});

test('the group for the current day is flagged isToday', () => {
  const now = new Date(2026, 5, 10, 8, 0, 0);
  const groups = groupByDay([timed(new Date(2026, 5, 10, 15, 0).toISOString())], { now });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].isToday, true, 'a clear "today" is a requirement');
});

test('all-day events sort ahead of timed events on the same day', () => {
  const now = new Date(2026, 5, 10, 6, 0, 0);
  const [group] = groupByDay(
    [
      timed(new Date(2026, 5, 10, 9, 0).toISOString(), { title: 'Timed' }),
      allDay('2026-06-10', '2026-06-10', { title: 'All day' }),
    ],
    { now }
  );

  assert.deepEqual(
    group.events.map((e) => e.title),
    ['All day', 'Timed']
  );
});

test('an event that finished yesterday is dropped', () => {
  const now = new Date(2026, 5, 10, 12, 0, 0);
  const groups = groupByDay([timed(new Date(2026, 5, 9, 9, 0).toISOString())], { now });
  assert.deepEqual(groups, []);
});

test('an event earlier TODAY is still shown, so the day looks complete', () => {
  const now = new Date(2026, 5, 10, 18, 0, 0);
  const groups = groupByDay([timed(new Date(2026, 5, 10, 9, 0).toISOString())], { now });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].isToday, true);
});

test('a multi-day all-day event in progress is shown under today', () => {
  const now = new Date(2026, 5, 14, 12, 0, 0);
  // Started the 13th, runs to the 15th — today is the 14th.
  const groups = groupByDay([allDay('2026-06-13', '2026-06-15', { title: 'Trip' })], { now });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].isToday, true, 'an in-progress trip belongs under Today');
  assert.equal(groups[0].events[0].title, 'Trip');
});

test('a finished multi-day all-day event is dropped', () => {
  const now = new Date(2026, 5, 20, 12, 0, 0);
  assert.deepEqual(groupByDay([allDay('2026-06-13', '2026-06-15')], { now }), []);
});

test('the limit caps total events, not events per day', () => {
  const now = new Date(2026, 5, 10, 6, 0, 0);
  const events = [
    timed(new Date(2026, 5, 10, 9, 0).toISOString(), { title: 'A' }),
    timed(new Date(2026, 5, 10, 10, 0).toISOString(), { title: 'B' }),
    timed(new Date(2026, 5, 11, 9, 0).toISOString(), { title: 'C' }),
  ];
  const groups = groupByDay(events, { now, limit: 2 });

  const titles = groups.flatMap((g) => g.events.map((e) => e.title));
  assert.deepEqual(titles, ['A', 'B'], 'the cap applies across the whole list');
});

test('an empty list groups to nothing rather than throwing', () => {
  assert.deepEqual(groupByDay([], { now: new Date(2026, 5, 10) }), []);
  assert.deepEqual(groupByDay(undefined, { now: new Date(2026, 5, 10) }), []);
});

// ── Formatting ──────────────────────────────────────────────────────────

test('an all-day event formats as "All day", never a time', () => {
  assert.equal(formatTimeRange(allDay('2026-06-12')), 'All day');
});

test('a timed event with an end formats as a range', () => {
  const start = new Date(2026, 5, 10, 9, 0).toISOString();
  const end = new Date(2026, 5, 10, 10, 0).toISOString();
  const text = formatTimeRange(timed(start, { end }), { locale: 'en-GB', hour12: false });
  assert.match(text, /09:00.*10:00/);
});

test('a timed event without an end shows only its start', () => {
  const start = new Date(2026, 5, 10, 9, 0).toISOString();
  const text = formatTimeRange(timed(start), { locale: 'en-GB', hour12: false });
  assert.equal(text, '09:00');
});

test('isMultiDay distinguishes a trip from a single all-day event', () => {
  assert.equal(isMultiDay(allDay('2026-06-12', '2026-06-12')), false);
  assert.equal(isMultiDay(allDay('2026-06-13', '2026-06-15')), true);
  assert.equal(isMultiDay(timed('2026-06-10T09:00:00.000Z')), false);
});

test('isPast is true only once an event has finished', () => {
  const now = new Date(2026, 5, 10, 12, 0, 0);
  const earlier = new Date(2026, 5, 10, 9, 0).toISOString();
  const later = new Date(2026, 5, 10, 15, 0).toISOString();

  assert.equal(isPast(timed(earlier), now), true);
  assert.equal(isPast(timed(later), now), false);
  // An all-day event covering today has not passed.
  assert.equal(isPast(allDay('2026-06-10'), now), false);
  assert.equal(isPast(allDay('2026-06-09'), now), true);
});

// ── Search entries ──────────────────────────────────────────────────────

test('every event contributes exactly one search entry', () => {
  const now = new Date(2026, 5, 10, 8, 0, 0);
  const events = [
    timed(new Date(2026, 5, 10, 9, 0).toISOString(), { title: 'Dentist' }),
    allDay('2026-06-12', '2026-06-12', { title: 'Bank holiday' }),
  ];
  const entries = toSearchEntries(events, { now });

  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.title),
    ['Dentist', 'Bank holiday']
  );
});

test('a search entry carries the shape the index expects', () => {
  const now = new Date(2026, 5, 10, 8, 0, 0);
  const [entry] = toSearchEntries(
    [
      timed(new Date(2026, 5, 10, 9, 0).toISOString(), {
        title: 'Dentist',
        location: 'High Street',
      }),
    ],
    { now, widgetId: 'cal-1' }
  );

  for (const key of ['id', 'widgetId', 'title', 'subtitle', 'keywords']) {
    assert.ok(key in entry, `entry should carry "${key}"`);
  }
  assert.equal(entry.widgetId, 'cal-1');
  assert.match(entry.subtitle, /Today/);
  assert.ok(entry.keywords.includes('High Street'));
});

test('an all-day search entry says "All day" rather than a wrong time', () => {
  const now = new Date(2026, 5, 10, 8, 0, 0);
  const [entry] = toSearchEntries([allDay('2026-06-12', '2026-06-12')], { now });
  assert.match(entry.subtitle, /All day/);
});
