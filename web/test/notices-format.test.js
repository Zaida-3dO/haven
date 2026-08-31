import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SEVERITY_PRESENTATION,
  absoluteDue,
  isOverdue,
  presentation,
  relativeDue,
  sortNotices,
  visibleNotices,
} from '../src/widgets/notices/format.js';

/**
 * The pure half of the widget. These are the rules most worth testing, because
 * "in 2 days" being wrong is exactly the kind of bug that looks fine in a
 * screenshot.
 *
 * Every fixture is invented — a notice is personal data.
 */

const NOW = Date.parse('2026-09-01T12:00:00Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const at = (offset) => new Date(NOW + offset).toISOString();

// ── Severity presentation ─────────────────────────────────────────────────

test('every severity carries a non-colour signal', () => {
  // Colour must not be the only carrier: the tile has to survive greyscale,
  // a colour vision deficiency and a screen reader.
  for (const level of ['info', 'warn', 'urgent']) {
    const look = presentation(level);
    assert.ok(look.icon, `${level} has no icon`);
    assert.ok(look.label, `${level} has no label`);
  }
});

test('the three severities are visually distinguishable from each other', () => {
  const icons = Object.values(SEVERITY_PRESENTATION).map((p) => p.icon);
  const labels = Object.values(SEVERITY_PRESENTATION).map((p) => p.label);

  assert.equal(new Set(icons).size, 3, 'two severities share an icon');
  assert.equal(new Set(labels).size, 3, 'two severities share a label');
});

test('severity ranks ascend from info to urgent', () => {
  assert.ok(presentation('info').rank < presentation('warn').rank);
  assert.ok(presentation('warn').rank < presentation('urgent').rank);
});

test('an unknown severity presents as info rather than blank', () => {
  // A tile with no badge at all would be worse than an over-cautious one.
  assert.deepEqual(presentation('catastrophic'), SEVERITY_PRESENTATION.info);
  assert.deepEqual(presentation(undefined), SEVERITY_PRESENTATION.info);
});

// ── Relative due times ────────────────────────────────────────────────────

test('a due date in the future reads as "in ..."', () => {
  assert.match(relativeDue(at(2 * DAY), { now: NOW, locale: 'en-GB' }), /in 2 days/);
});

test('a past due date reads as "... ago"', () => {
  assert.match(relativeDue(at(-3 * HOUR), { now: NOW, locale: 'en-GB' }), /3 hours ago/);
});

test('the unit is chosen by magnitude — days, not 48 hours', () => {
  const phrase = relativeDue(at(2 * DAY), { now: NOW, locale: 'en-GB' });
  assert.ok(!phrase.includes('hour'), `"${phrase}" should be in days`);
});

test('minutes are used inside an hour', () => {
  assert.match(relativeDue(at(20 * MINUTE), { now: NOW, locale: 'en-GB' }), /20 minutes/);
});

test('weeks are used beyond a week', () => {
  assert.match(relativeDue(at(14 * DAY), { now: NOW, locale: 'en-GB' }), /2 weeks/);
});

test('months are used beyond about five weeks', () => {
  assert.match(relativeDue(at(90 * DAY), { now: NOW, locale: 'en-GB' }), /3 months/);
});

test('under a minute reads as "now" rather than a jittery number', () => {
  assert.equal(relativeDue(at(30 * 1000), { now: NOW }), 'now');
  assert.equal(relativeDue(at(-30 * 1000), { now: NOW }), 'now');
});

test('no due date produces no phrase at all', () => {
  assert.equal(relativeDue(null, { now: NOW }), null);
  assert.equal(relativeDue(undefined, { now: NOW }), null);
});

test('an unparseable due date produces no phrase rather than "Invalid Date"', () => {
  assert.equal(relativeDue('sometime', { now: NOW }), null);
});

test('the absolute form is what the tooltip shows, and it names the day', () => {
  // Relative at a glance; absolute when you are actually planning around it.
  const absolute = absoluteDue(at(2 * DAY), { locale: 'en-GB' });
  assert.match(absolute, /September/);
  assert.match(absolute, /\d{2}:\d{2}/);
});

test('overdue is detectable, and only when the date has actually passed', () => {
  assert.equal(isOverdue(at(-HOUR), { now: NOW }), true);
  assert.equal(isOverdue(at(HOUR), { now: NOW }), false);
  assert.equal(isOverdue(null, { now: NOW }), false);
});

// ── Ordering ──────────────────────────────────────────────────────────────

const notice = (overrides = {}) => ({
  id: 'n',
  severity: 'info',
  title: 'A notice',
  due: null,
  source: 'chores',
  actions: [],
  ...overrides,
});

test('due drives the ordering — soonest first', () => {
  const sorted = sortNotices([
    notice({ id: 'c', title: 'Later', due: at(5 * DAY) }),
    notice({ id: 'a', title: 'Sooner', due: at(HOUR) }),
    notice({ id: 'b', title: 'Middle', due: at(2 * DAY) }),
  ]);

  assert.deepEqual(
    sorted.map((n) => n.title),
    ['Sooner', 'Middle', 'Later']
  );
});

test('undated notices sort last however urgent they are', () => {
  // "Service the boiler eventually" above something due in an hour would be
  // actively misleading.
  const sorted = sortNotices([
    notice({ id: 'a', title: 'Someday', severity: 'urgent' }),
    notice({ id: 'b', title: 'Today', severity: 'info', due: at(HOUR) }),
  ]);

  assert.deepEqual(
    sorted.map((n) => n.title),
    ['Today', 'Someday']
  );
});

test('severity breaks a tie on due date, most urgent first', () => {
  const due = at(DAY);
  const sorted = sortNotices([
    notice({ id: 'a', severity: 'info', title: 'Info', due }),
    notice({ id: 'b', severity: 'urgent', title: 'Urgent', due }),
    notice({ id: 'c', severity: 'warn', title: 'Warn', due }),
  ]);

  assert.deepEqual(
    sorted.map((n) => n.severity),
    ['urgent', 'warn', 'info']
  );
});

test('sorting does not mutate the array it was given', () => {
  const input = [notice({ id: 'b', due: at(2 * DAY) }), notice({ id: 'a', due: at(HOUR) })];
  const before = input.map((n) => n.id);

  sortNotices(input);

  assert.deepEqual(
    input.map((n) => n.id),
    before
  );
});

test('an overdue notice still sorts above a future one', () => {
  const sorted = sortNotices([
    notice({ id: 'b', title: 'Soon', due: at(HOUR) }),
    notice({ id: 'a', title: 'Late', due: at(-2 * DAY) }),
  ]);

  assert.deepEqual(
    sorted.map((n) => n.title),
    ['Late', 'Soon']
  );
});

// ── The config filters ────────────────────────────────────────────────────

test('minSeverity hides anything below the floor', () => {
  const visible = visibleNotices(
    [
      notice({ id: 'a', severity: 'info', title: 'Info' }),
      notice({ id: 'b', severity: 'warn', title: 'Warn' }),
      notice({ id: 'c', severity: 'urgent', title: 'Urgent' }),
    ],
    { minSeverity: 'warn', maxItems: 10 }
  );

  assert.deepEqual(
    visible.map((n) => n.title),
    ['Urgent', 'Warn']
  );
});

test('maxItems caps the list', () => {
  const many = Array.from({ length: 10 }, (_, i) => notice({ id: `n${i}`, due: at(i * HOUR) }));
  assert.equal(visibleNotices(many, { maxItems: 3 }).length, 3);
});

test('filtering happens BEFORE capping', () => {
  // Capping first would let eight info notices hide the one urgent notice the
  // user set the filter to catch.
  const notices = [
    ...Array.from({ length: 8 }, (_, i) => notice({ id: `i${i}`, severity: 'info', due: at(i) })),
    notice({ id: 'u', severity: 'urgent', title: 'The urgent one', due: at(9 * HOUR) }),
  ];

  const visible = visibleNotices(notices, { minSeverity: 'urgent', maxItems: 3 });

  assert.deepEqual(
    visible.map((n) => n.title),
    ['The urgent one']
  );
});

test('the default floor shows everything', () => {
  const notices = [notice({ id: 'a', severity: 'info' })];
  assert.equal(visibleNotices(notices, {}).length, 1);
});

test('an absurd maxItems falls back to showing everything rather than nothing', () => {
  const notices = [notice({ id: 'a' }), notice({ id: 'b' })];
  assert.equal(visibleNotices(notices, { maxItems: 0 }).length, 2);
  assert.equal(visibleNotices(notices, { maxItems: NaN }).length, 2);
});

test('an empty list stays empty rather than throwing', () => {
  assert.deepEqual(visibleNotices([], {}), []);
  assert.deepEqual(visibleNotices(undefined, {}), []);
});
