import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeDocument, FakeElement } from './helpers/fake-dom.js';
import { doneData, loadingData, errorData, staleData } from '../src/shell/panel-data.js';
import { WidgetRegistry } from '../src/shell/registry.js';
import { SearchIndex } from '../src/shell/search-index.js';
import { parseConfig } from '../src/shell/schema.js';

/**
 * The widget resolves its base class at import time (`globalThis.HTMLElement`
 * or a bare class), so the stand-in must be installed BEFORE that import is
 * evaluated. Static imports are hoisted, hence the dynamic import below.
 */
globalThis.HTMLElement = FakeElement;
globalThis.document = createFakeDocument();

const {
  CalendarWidget,
  calendarDataSource,
  calendarStubConfig,
  calendarConfigSchema,
  CALENDAR_WIDGET_TYPE,
  GOOGLE_CALENDAR_URL,
} = await import('../src/widgets/calendar/calendar-widget.js');
const { register: registerCalendar, definition: calendarDefinition } =
  await import('../src/widgets/calendar/index.js');

/**
 * The widget builds DOM through the global `document`, so the fake document
 * is installed for the duration of a render. `HTMLElement` likewise does not
 * exist under Node, so a minimal base is provided — the widget only relies on
 * `attachShadow`, which `FakeElement` implements.
 */
function withFakeDom(fn) {
  const previousDocument = globalThis.document;
  // A fresh document per render, so element identity assertions cannot be
  // satisfied by leftovers from a previous test.
  globalThis.document = createFakeDocument();
  try {
    return fn(globalThis.document);
  } finally {
    globalThis.document = previousDocument;
  }
}

const NOW = () => new Date(2026, 5, 10, 9, 0, 0);

const timed = (start, overrides = {}) => ({
  id: `t-${start}-${overrides.title ?? ''}`,
  title: 'Timed',
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

const allDay = (startDate, overrides = {}) => ({
  id: `a-${startDate}-${overrides.title ?? ''}`,
  title: 'All day',
  allDay: true,
  start: null,
  end: null,
  startDate,
  endDate: startDate,
  feedId: 'feed-1',
  feedName: 'Calendar',
  location: null,
  ...overrides,
});

/** Build a widget, push a payload, render, and hand back the shadow root. */
function renderWith(value, { config = {}, makeData = doneData } = {}) {
  return withFakeDom(() => {
    const widget = new CalendarWidget();
    widget.setNow(NOW);
    widget.setConfig({ ...calendarStubConfig(), ...config });
    widget.onData(makeData(value));
    widget.render();
    return { widget, root: widget.shadowRoot };
  });
}

const textOf = (node) => (node ? node.textContent : null);
const findAll = (root, selector) => root.querySelectorAll(selector);

/** Every element in the rendered tree, root first. */
function* walk(node) {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

// ── The contract ────────────────────────────────────────────────────────

test('the widget declares no timer and fetches nothing itself', () => {
  const source = calendarDataSource();
  // `dataSource` DESCRIBES a request; the host performs it.
  assert.equal(source.url, '/api/widgets/calendar');
  assert.equal(typeof source.key, 'string');

  const text = String(CalendarWidget);
  assert.ok(!text.includes('setInterval'), 'a widget must never own a timer');
  assert.ok(!text.includes('fetch('), 'a widget must never fetch');
});

test('every calendar instance collapses onto ONE backend request', () => {
  // Two tiles pointed at the same endpoint must dedup in the fetcher, which
  // only happens if their cache keys match.
  assert.equal(calendarDataSource({ title: 'A' }).key, calendarDataSource({ title: 'B' }).key);
});

test('the stub config validates against the schema', () => {
  // getStubConfig is what makes "Add widget" produce a working tile rather
  // than an error card, so it must satisfy the widget's own validator.
  assert.doesNotThrow(() => parseConfig(calendarConfigSchema, calendarStubConfig()));
});

test('setConfig throws on a bad config, per the contract', () => {
  withFakeDom(() => {
    const widget = new CalendarWidget();
    assert.throws(() => widget.setConfig({ maxEvents: 0 }), /positive number/);
    assert.throws(() => widget.setConfig({ maxEvents: 'lots' }), /positive number/);
  });
});

test('the definition registers cleanly and is searchable', () => {
  const registry = new WidgetRegistry();
  const definition = registerCalendar(registry);

  assert.equal(definition.type, CALENDAR_WIDGET_TYPE);
  assert.equal(definition.searchable, true);
  assert.ok(definition.refreshMs > 0, 'the HOST refreshes on this interval');
  assert.equal(typeof definition.dataSource, 'function');
  // The registry normalises and freezes, and validates configSchema there and
  // then — so a malformed schema would fail here rather than inside a form.
  assert.equal(definition.tag, calendarDefinition.tag);
});

test('the stub config the host inserts is valid for the registered schema', () => {
  const registry = new WidgetRegistry();
  registerCalendar(registry);
  assert.doesNotThrow(() => parseConfig(calendarConfigSchema, registry.stubConfig('calendar')));
});

// ── Rendering ───────────────────────────────────────────────────────────

test('events render grouped under day headings, with today marked', () => {
  const { root } = renderWith({
    configured: true,
    feeds: [{ id: 'feed-1', name: 'Calendar' }],
    events: [
      timed(new Date(2026, 5, 10, 14, 0).toISOString(), { title: 'Today thing' }),
      timed(new Date(2026, 5, 11, 9, 0).toISOString(), { title: 'Tomorrow thing' }),
    ],
    problems: [],
    stale: false,
  });

  const days = findAll(root, '.cal__day');
  assert.equal(days.length, 2);

  const today = days.find((d) => d.classList.contains('cal__day--today'));
  assert.ok(today, 'the current day must be distinguishable');
  assert.equal(textOf(today.querySelector('.cal__daylabel')), 'Today');
});

test('an all-day event is rendered distinctly from a timed one', () => {
  const { root } = renderWith({
    configured: true,
    feeds: [{ id: 'feed-1', name: 'Calendar' }],
    events: [
      allDay('2026-06-10', { title: 'Holiday' }),
      timed(new Date(2026, 5, 10, 14, 0).toISOString(), { title: 'Meeting' }),
    ],
    problems: [],
    stale: false,
  });

  const events = findAll(root, '.cal__event');
  assert.equal(events.length, 2);

  const allDayRow = events.find((e) => e.dataset.allDay === 'true');
  const timedRow = events.find((e) => e.dataset.allDay === 'false');

  assert.ok(allDayRow, 'expected an all-day row');
  assert.ok(timedRow, 'expected a timed row');
  // Distinct by CLASS, not merely by the text in the time column.
  assert.ok(
    allDayRow.classList.contains('cal__event--allday'),
    'an all-day event needs its own styling hook'
  );
  assert.ok(!timedRow.classList.contains('cal__event--allday'));
  assert.equal(textOf(allDayRow.querySelector('.cal__when')), 'All day');
});

test('event titles are written as text, never as markup', () => {
  const nasty = '<img src=x onerror=alert(1)>';
  const { root } = renderWith({
    configured: true,
    feeds: [{ id: 'feed-1', name: 'Calendar' }],
    events: [timed(new Date(2026, 5, 10, 14, 0).toISOString(), { title: nasty })],
    problems: [],
    stale: false,
  });

  // Anyone who can put an event in the calendar controls this string.
  const name = root.querySelector('.cal__name');
  assert.equal(textOf(name), nasty, 'the title is inert text, not parsed markup');
});

test('several feeds are visually distinguishable', () => {
  const { root } = renderWith({
    configured: true,
    feeds: [
      { id: 'feed-1', name: 'Personal' },
      { id: 'feed-2', name: 'Work' },
    ],
    events: [
      timed(new Date(2026, 5, 10, 10, 0).toISOString(), {
        title: 'Mine',
        feedId: 'feed-1',
        feedName: 'Personal',
      }),
      timed(new Date(2026, 5, 10, 11, 0).toISOString(), {
        title: 'Theirs',
        feedId: 'feed-2',
        feedName: 'Work',
      }),
    ],
    problems: [],
    stale: false,
  });

  const rows = findAll(root, '.cal__event');
  const colours = rows.map((r) => r.style.borderLeftColor);
  assert.equal(colours.filter(Boolean).length, 2, 'each feed gets a colour');
  assert.notEqual(colours[0], colours[1], 'and the colours differ');

  const names = findAll(root, '.cal__feed').map(textOf);
  assert.deepEqual(names.sort(), ['Personal', 'Work']);
});

test('a single feed is not labelled with its name — it would be noise', () => {
  const { root } = renderWith({
    configured: true,
    feeds: [{ id: 'feed-1', name: 'Calendar' }],
    events: [timed(new Date(2026, 5, 10, 10, 0).toISOString(), { title: 'Only one' })],
    problems: [],
    stale: false,
  });

  assert.equal(findAll(root, '.cal__feed').length, 0);
});

test('the empty state is a quiet message, not an error', () => {
  const { root } = renderWith({
    configured: true,
    feeds: [{ id: 'feed-1', name: 'Calendar' }],
    events: [],
    problems: [],
    stale: false,
  });

  const empty = root.querySelector('.cal__empty');
  assert.ok(empty);
  assert.match(textOf(empty), /Nothing coming up/i);
});

test('an unconfigured connector renders a setup hint, not an error', () => {
  const { root } = renderWith({
    configured: false,
    feeds: [],
    events: [],
    problems: [],
    stale: false,
    hint: 'Set HAVEN_CALENDAR_ICS_URL to a calendar’s secret iCal address.',
  });

  const setup = root.querySelector('.cal__setup');
  assert.ok(setup, 'expected the not-configured tile');
  assert.match(textOf(setup), /No calendar connected/i);
  assert.match(textOf(setup), /HAVEN_CALENDAR_ICS_URL/);
  assert.equal(root.querySelector('.cal__empty'), null, 'not an error or empty state');
});

test('stale data renders the events WITH a marker, not an error box', () => {
  const { root } = renderWith(
    {
      configured: true,
      feeds: [{ id: 'feed-1', name: 'Calendar' }],
      events: [timed(new Date(2026, 5, 10, 14, 0).toISOString(), { title: 'Still here' })],
      problems: [{ feedId: 'feed-1', feedName: 'Calendar', message: 'ECONNREFUSED' }],
      stale: true,
    },
    { makeData: (value) => staleData(value) }
  );

  // A soft notice is not a hard error: the data still renders.
  assert.equal(findAll(root, '.cal__event').length, 1);
  const notice = root.querySelector('.cal__notice');
  assert.ok(notice, 'a staleness marker is required');
  assert.match(textOf(notice), /cached/i);
});

test('fresh data carries no staleness marker', () => {
  const { root } = renderWith({
    configured: true,
    feeds: [{ id: 'feed-1', name: 'Calendar' }],
    events: [timed(new Date(2026, 5, 10, 14, 0).toISOString())],
    problems: [],
    stale: false,
  });
  assert.equal(root.querySelector('.cal__notice'), null);
});

test('a hard error with no cached value says so', () => {
  const { root } = renderWith(null, {
    makeData: (v) => errorData(new Error('boom'), { previous: v }),
  });
  assert.match(textOf(root.querySelector('.cal__empty')), /Could not load/i);
});

test('the loading state does not flash an error', () => {
  const { root } = renderWith(null, { makeData: () => loadingData() });
  const empty = root.querySelector('.cal__empty');
  assert.match(textOf(empty), /Loading/i);
});

test('maxEvents caps what is rendered', () => {
  const events = Array.from({ length: 10 }, (_, i) =>
    timed(new Date(2026, 5, 10, 10 + i, 0).toISOString(), { title: `Event ${i}` })
  );
  const { root } = renderWith(
    {
      configured: true,
      feeds: [{ id: 'feed-1', name: 'Calendar' }],
      events,
      problems: [],
      stale: false,
    },
    { config: { maxEvents: 3 } }
  );
  assert.equal(findAll(root, '.cal__event').length, 3);
});

test('a past event today is de-emphasised rather than dropped', () => {
  const { root } = renderWith({
    configured: true,
    feeds: [{ id: 'feed-1', name: 'Calendar' }],
    events: [
      // NOW is 09:00; this finished at 08:30.
      timed(new Date(2026, 5, 10, 8, 0).toISOString(), {
        title: 'Earlier',
        end: new Date(2026, 5, 10, 8, 30).toISOString(),
      }),
    ],
    problems: [],
    stale: false,
  });

  const row = root.querySelector('.cal__event');
  assert.ok(row, 'an earlier event today should still be listed');
  assert.ok(row.classList.contains('cal__event--past'));
});

test('the location is shown, and can be turned off', () => {
  const value = {
    configured: true,
    feeds: [{ id: 'feed-1', name: 'Calendar' }],
    events: [timed(new Date(2026, 5, 10, 14, 0).toISOString(), { location: 'High Street' })],
    problems: [],
    stale: false,
  };

  const shown = renderWith(value);
  assert.equal(textOf(shown.root.querySelector('.cal__where')), 'High Street');

  const hidden = renderWith(value, { config: { showLocation: 'no' } });
  assert.equal(hidden.root.querySelector('.cal__where'), null);
});

test('an unchanged revision does not redraw', () => {
  withFakeDom(() => {
    const widget = new CalendarWidget();
    widget.setNow(NOW);
    widget.setConfig(calendarStubConfig());

    const payload = doneData({
      configured: true,
      feeds: [{ id: 'feed-1', name: 'Calendar' }],
      events: [timed(new Date(2026, 5, 10, 14, 0).toISOString())],
      problems: [],
      stale: false,
    });

    widget.onData(payload);
    widget.render();
    const first = widget.shadowRoot.children[1];

    // Same payload, same revision — the tree must not be rebuilt.
    widget.onData(payload);
    widget.render();
    assert.equal(widget.shadowRoot.children[1], first, 'diff and patch, never redraw every tick');
  });
});

// ── Search ──────────────────────────────────────────────────────────────

test('each event contributes a search entry', () => {
  const { widget } = renderWith({
    configured: true,
    feeds: [{ id: 'feed-1', name: 'Calendar' }],
    events: [
      timed(new Date(2026, 5, 10, 14, 0).toISOString(), { title: 'Dentist' }),
      allDay('2026-06-12', { title: 'Bank holiday' }),
    ],
    problems: [],
    stale: false,
  });

  const entries = widget.getSearchEntries();
  assert.deepEqual(entries.map((e) => e.title).sort(), ['Bank holiday', 'Dentist']);
});

test('search entries reach the index and are findable', () => {
  const { widget } = renderWith({
    configured: true,
    feeds: [{ id: 'feed-1', name: 'Calendar' }],
    events: [timed(new Date(2026, 5, 10, 14, 0).toISOString(), { title: 'Dentist appointment' })],
    problems: [],
    stale: false,
  });

  const index = new SearchIndex();
  index.setEntries('cal-1', widget.getSearchEntries(), { label: 'Calendar' });

  const hits = index.search('dentist');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, 'Dentist appointment');
});

test('a widget with no data contributes no entries rather than throwing', () => {
  withFakeDom(() => {
    const widget = new CalendarWidget();
    widget.setConfig(calendarStubConfig());
    assert.deepEqual(widget.getSearchEntries(), []);
  });
});

test('the widget never writes search data to storage', () => {
  // The index holds event titles and is in-memory only. The widget hands
  // entries to the shell and must not persist them itself.
  const source = String(CalendarWidget) + String(calendarDefinition.dataSource);
  for (const api of ['localStorage', 'sessionStorage', 'indexedDB']) {
    assert.ok(!source.includes(api), `event titles must never reach ${api}`);
  }
});

// ── The way out to a calendar you can change ────────────────────────────
//
// The tile is read-only: it is built from ICS feeds, and an iCal address
// grants read access only. The link is therefore the whole of the affordance
// for adding or changing an event, so it has to be present and it has to be
// safe.

test('the tile offers a link out to Google Calendar, opened safely', () => {
  const { root } = renderWith({
    configured: true,
    feeds: [{ id: 'feed-1', name: 'Personal' }],
    events: [timed(new Date(2026, 5, 10, 10, 0).toISOString(), { title: 'Standup' })],
    problems: [],
    stale: false,
  });

  const link = root.querySelector('.cal__open');
  assert.ok(link, 'the tile must offer a way to reach an editable calendar');
  assert.equal(link.href, GOOGLE_CALENDAR_URL);
  assert.equal(link.target, '_blank');

  // `target="_blank"` without this hands the opened page a `window.opener`
  // handle back to the dashboard.
  const rel = link.rel.split(/\s+/);
  assert.ok(rel.includes('noopener'), 'a _blank link must set noopener');
  assert.ok(rel.includes('noreferrer'), 'a _blank link must set noreferrer');
});

test('the link is still there when no feed is configured', () => {
  // The "no calendar connected" tile is exactly when a user most wants the
  // real calendar, so the way out must not be hidden behind having a feed.
  const { root } = renderWith({
    configured: false,
    events: [],
    feeds: [],
    problems: [],
    stale: false,
    hint: 'Set HAVEN_CALENDAR_ICS_URL to a calendar’s secret iCal address.',
  });

  assert.ok(root.querySelector('.cal__open'), 'the link must survive the unconfigured tile');
});

test('no feed URL can reach the link, whatever the server sends', () => {
  /**
   * An ICS feed URL is a BEARER CREDENTIAL. The server is built never to send
   * one, but this asserts the widget could not leak it into an href even if
   * that changed — the link is a fixed constant, not derived from feed data.
   */
  const secret = 'https://calendar.google.com/calendar/ical/SECRET-TOKEN/basic.ics';

  const { root } = renderWith({
    configured: true,
    feeds: [{ id: 'feed-1', name: 'Personal', url: secret }],
    events: [timed(new Date(2026, 5, 10, 10, 0).toISOString(), { title: 'Standup', url: secret })],
    problems: [],
    stale: false,
  });

  const link = root.querySelector('.cal__open');
  assert.equal(link.href, GOOGLE_CALENDAR_URL);
  assert.ok(!link.href.includes('SECRET-TOKEN'), 'a feed credential must never reach an href');

  // And nowhere else in the rendered tile either. Walked explicitly rather
  // than serialised: the tree is circular (`parentNode`), so `JSON.stringify`
  // throws — and even where it does not, it would skip exactly the places a
  // credential would actually land (attributes, dataset, inline style).
  for (const node of walk(root)) {
    const surfaces = [
      node.textContent,
      node.className,
      // Set as plain properties by the widget, so they never reach
      // `attributes` (which only `setAttribute` populates) — and an href or a
      // title is exactly where a credential would land.
      node.href,
      node.title,
      node.src,
      ...[...node.attributes.values()],
      ...Object.values(node.dataset),
      ...Object.values(node.style),
    ];

    for (const surface of surfaces) {
      assert.ok(
        !String(surface ?? '').includes('SECRET-TOKEN'),
        `a feed credential must never reach the DOM (found on <${node.tagName}>)`
      );
    }
  }
});
