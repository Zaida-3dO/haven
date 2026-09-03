/**
 * The local calendar write API, end to end through `app.inject()`.
 *
 * Two behaviours here are the reason this feature is safe to expose at all,
 * and both are pinned by name:
 *
 *   - "an ICS-sourced event cannot be edited" — writes only reach Haven's own
 *     store, because a secret iCal address is a read credential and there is
 *     nothing to write back to.
 *   - "a second feed's events appear in the merged view" — the multi-calendar
 *     half actually merges, rather than the first feed winning.
 *
 * No test here touches the network: the connector is injected with a stubbed
 * fetch over `.invalid` fixtures (docs/SECURITY.md — never a live feed, never
 * real event data).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../src/server.js';
import { createCalendarConnector } from '../src/connectors/calendar.js';
import { MAX_BATCH, MAX_BODY_BYTES } from '../src/routes/calendar-events.js';
import {
  FAKE_FEED_URL,
  SECOND_FEED_URL,
  SAMPLE_ICS,
  createFakeFetch,
  icsResponse,
} from './helpers/ics-fixtures.js';

const NOW = Date.parse('2026-06-01T00:00:00Z');

/**
 * A date a few days from the REAL clock, as `YYYY-MM-DD`.
 *
 * The stubbed feed connector is pinned to a fake `now`, but the merged read's
 * default window is derived from the real clock — so a local event written at
 * a hard-coded 2026 date falls outside the default window and vanishes. Tests
 * that care about the DEFAULT window therefore place their events relative to
 * today; tests that pass an explicit `from`/`to` can use fixed dates.
 */
function soon(daysFromNow = 2) {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

/** JSON headers, so the content-type guard is satisfied by default. */
const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * A server with a real (in-memory) database and an optionally-stubbed feed.
 *
 * `icsUrl: ''` means "no feeds configured", which is how the local-only paths
 * are exercised.
 */
async function serverWith({ icsUrl = '', routes = new Map() } = {}) {
  return buildServer({
    dbPath: ':memory:',
    logger: false,
    seedPath: 'config/does-not-exist.json',
    widgets: {
      calendarConnector: createCalendarConnector({
        icsUrl,
        fetchImpl: createFakeFetch(routes),
        now: () => NOW,
      }),
    },
  });
}

const post = (app, payload, headers = JSON_HEADERS) =>
  app.inject({ method: 'POST', url: '/api/calendar/events', headers, payload });

/** Create one event and return it, failing loudly if creation did not work. */
async function createEvent(app, body) {
  const response = await post(app, body);
  assert.equal(response.statusCode, 201, `create failed: ${response.body}`);
  return response.json().events[0];
}

// ── Create ───────────────────────────────────────────────────────────────

test('POST creates a local event and returns it with a local id and source', async (t) => {
  const app = await serverWith();
  t.after(() => app.close());

  const response = await post(app, {
    title: 'Dentist',
    start: '2026-06-12T09:00:00Z',
    end: '2026-06-12T09:30:00Z',
    location: 'Chair 2',
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.written, 1);

  const [event] = body.events;
  assert.match(event.id, /^local:/);
  // `source` is what a calling agent uses to know it may edit this. It is
  // stamped by the store, never taken from the request.
  assert.equal(event.source, 'local');
  assert.equal(event.title, 'Dentist');
  assert.equal(event.start, '2026-06-12T09:00:00.000Z');
});

test('POST accepts a batch and reports every bad entry, storing none of them', async (t) => {
  const app = await serverWith();
  t.after(() => app.close());

  const response = await post(app, [
    { title: 'fine', start: '2026-06-12T09:00:00Z' },
    { title: '', start: '2026-06-12T09:00:00Z' },
    { title: 'bad', start: 'whenever' },
  ]);

  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.errors.length, 2, 'both bad entries should be named in one round trip');
  assert.deepEqual(
    body.errors.map((e) => e.index),
    [1, 2]
  );

  // All-or-nothing: the valid entry must not have landed either.
  const after = await app.inject({ method: 'GET', url: '/api/widgets/calendar/events' });
  assert.equal(after.json().events.length, 0, 'a rejected batch must store nothing');
});

test('a batch over the cap is refused before anything is parsed', async (t) => {
  const app = await serverWith();
  t.after(() => app.close());

  const many = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({
    title: `Event ${i}`,
    start: '2026-06-12T09:00:00Z',
  }));

  const response = await post(app, many);
  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error, 'BATCH_TOO_LARGE');
});

test('a body that is not application/json is refused with 415', async (t) => {
  const app = await serverWith();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/calendar/events',
    headers: { 'content-type': 'text/plain' },
    payload: JSON.stringify({ title: 'x', start: '2026-06-12T09:00:00Z' }),
  });

  assert.equal(response.statusCode, 415);
  assert.equal(response.json().error, 'UNSUPPORTED_MEDIA_TYPE');
});

test('an oversized body is refused rather than buffered and parsed', async (t) => {
  const app = await serverWith();
  t.after(() => app.close());

  const response = await post(app, [
    { title: 'x', start: '2026-06-12T09:00:00Z', description: 'y'.repeat(MAX_BODY_BYTES) },
  ]);

  // Fastify enforces `bodyLimit` before the JSON parser runs.
  assert.equal(response.statusCode, 413);
});

// ── The refusal that matters most ────────────────────────────────────────

test('an ICS-sourced event cannot be edited, and the refusal says why', async (t) => {
  const app = await serverWith({
    icsUrl: FAKE_FEED_URL,
    routes: new Map([[FAKE_FEED_URL, () => icsResponse(SAMPLE_ICS)]]),
  });
  t.after(() => app.close());

  // Take a real feed event id out of the merged view — exactly what a calling
  // agent holds after a read, with no way to know it is unwritable until it
  // tries.
  const merged = await app.inject({ method: 'GET', url: '/api/widgets/calendar/events' });
  const feedEvent = merged.json().events.find((event) => event.source === 'feed');
  assert.ok(feedEvent, 'the fixture should have produced at least one feed event');

  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/calendar/events/${encodeURIComponent(feedEvent.id)}`,
    headers: JSON_HEADERS,
    payload: { title: 'Hijacked' },
  });

  assert.equal(patch.statusCode, 403, 'a well-formed write to a feed event is forbidden, not 400');
  const body = patch.json();
  assert.equal(body.error, 'READ_ONLY_EVENT');
  // The message is the deliverable: an agent must learn the RULE, not just
  // that it failed. A generic 400 would teach it to retry with different JSON.
  assert.match(body.message, /read-only/i);
  assert.match(body.message, /local:/);
  assert.equal(body.editable, false);

  // And nothing changed.
  const after = await app.inject({ method: 'GET', url: '/api/widgets/calendar/events' });
  const stillThere = after.json().events.find((event) => event.id === feedEvent.id);
  assert.equal(stillThere.title, feedEvent.title, 'the feed event must be untouched');
});

test('an ICS-sourced event cannot be deleted either', async (t) => {
  const app = await serverWith({
    icsUrl: FAKE_FEED_URL,
    routes: new Map([[FAKE_FEED_URL, () => icsResponse(SAMPLE_ICS)]]),
  });
  t.after(() => app.close());

  const merged = await app.inject({ method: 'GET', url: '/api/widgets/calendar/events' });
  const feedEvent = merged.json().events.find((event) => event.source === 'feed');

  const response = await app.inject({
    method: 'DELETE',
    url: `/api/calendar/events/${encodeURIComponent(feedEvent.id)}`,
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, 'READ_ONLY_EVENT');

  const after = await app.inject({ method: 'GET', url: '/api/widgets/calendar/events' });
  assert.ok(
    after.json().events.some((event) => event.id === feedEvent.id),
    'the feed event must survive the attempted delete'
  );
});

test('a POST cannot mint an event that claims to be from a feed', async (t) => {
  const app = await serverWith();
  t.after(() => app.close());

  const response = await post(app, {
    title: 'Pretending',
    start: '2026-06-12T09:00:00Z',
    source: 'feed-1',
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errors[0].field, 'source');
});

// ── Edit and delete a local event ────────────────────────────────────────

test('PATCH edits a local event and leaves untouched fields alone', async (t) => {
  const app = await serverWith();
  t.after(() => app.close());

  const created = await createEvent(app, {
    title: 'Dentist',
    start: '2026-06-12T09:00:00Z',
    end: '2026-06-12T09:30:00Z',
    location: 'Chair 2',
  });

  const response = await app.inject({
    method: 'PATCH',
    url: `/api/calendar/events/${encodeURIComponent(created.id)}`,
    headers: JSON_HEADERS,
    payload: { title: 'Hygienist' },
  });

  assert.equal(response.statusCode, 200);
  const event = response.json().event;
  assert.equal(event.title, 'Hygienist');
  assert.equal(event.location, 'Chair 2', 'an unmentioned field must survive the patch');
  assert.equal(event.start, created.start);
});

test('DELETE removes a local event, and a second delete is a 404', async (t) => {
  const app = await serverWith();
  t.after(() => app.close());

  const created = await createEvent(app, { title: 'Gone', start: '2026-06-12T09:00:00Z' });
  const url = `/api/calendar/events/${encodeURIComponent(created.id)}`;

  const first = await app.inject({ method: 'DELETE', url });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().deleted, true);

  // Not a cheerful 204: a caller deleting something that is not there is
  // holding a stale id, and being told so is more useful.
  const second = await app.inject({ method: 'DELETE', url });
  assert.equal(second.statusCode, 404);
});

test('an unknown local id is a 404, not a read-only refusal', async (t) => {
  const app = await serverWith();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'PATCH',
    url: '/api/calendar/events/local:does-not-exist',
    headers: JSON_HEADERS,
    payload: { title: 'x' },
  });

  // The two failures mean different things and must not be conflated: 404 is
  // "gone", 403 is "this kind of event is never writable".
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, 'NOT_FOUND');
});

// ── The merged view ──────────────────────────────────────────────────────

test('a second feed’s events appear alongside the first', async (t) => {
  const app = await serverWith({
    icsUrl: `Ope|${FAKE_FEED_URL},Tomi|${SECOND_FEED_URL}`,
    routes: new Map([
      [FAKE_FEED_URL, () => icsResponse(SAMPLE_ICS)],
      [SECOND_FEED_URL, () => icsResponse(SAMPLE_ICS)],
    ]),
  });
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/widgets/calendar/events' });
  assert.equal(response.statusCode, 200);
  const body = response.json();

  // Both feeds are named…
  assert.deepEqual(
    body.feeds.map((feed) => feed.name),
    ['Ope', 'Tomi', 'Haven']
  );

  // …and BOTH have contributed events. The failure this guards against is the
  // merge dropping everything after the first feed, which looks perfectly
  // healthy from the outside: one calendar's worth of events, no error.
  const feedIds = new Set(body.events.map((event) => event.feedId));
  assert.ok(feedIds.has('feed-1'), 'the first feed contributed no events');
  assert.ok(feedIds.has('feed-2'), 'the second feed contributed no events');

  // Every event knows which feed it came from — the attribution the widget
  // colours by.
  for (const event of body.events) {
    assert.ok(event.feedId, `event ${event.id} has no feedId`);
    assert.ok(event.feedName, `event ${event.id} has no feedName`);
  }
});

test('local events merge into the same view as the feeds, sorted together', async (t) => {
  const app = await serverWith({
    icsUrl: FAKE_FEED_URL,
    routes: new Map([[FAKE_FEED_URL, () => icsResponse(SAMPLE_ICS)]]),
  });
  t.after(() => app.close());

  await createEvent(app, { title: 'Haven-made', start: `${soon(2)}T09:00:00Z` });

  const body = (await app.inject({ method: 'GET', url: '/api/widgets/calendar/events' })).json();

  const sources = new Set(body.events.map((event) => event.source));
  assert.ok(sources.has('feed'), 'feed events missing from the merged view');
  assert.ok(sources.has('local'), 'local events missing from the merged view');

  // One list, one sort. Two lists concatenated would leave the local event
  // wherever it happened to land.
  const keys = body.events.map((event) => event.start ?? event.startDate);
  assert.deepEqual([...keys].sort(), keys, 'the merged list is not chronologically sorted');
});

test('the range filter windows both sources', async (t) => {
  const app = await serverWith();
  t.after(() => app.close());

  await createEvent(app, { title: 'In June', start: '2026-06-15T09:00:00Z' });
  await createEvent(app, { title: 'In July', start: '2026-07-15T09:00:00Z' });

  const june = (
    await app.inject({
      method: 'GET',
      url: '/api/widgets/calendar/events?from=2026-06-01&to=2026-06-30',
    })
  ).json();

  assert.deepEqual(
    june.events.map((event) => event.title),
    ['In June']
  );
  assert.deepEqual(june.range, {
    from: '2026-06-01T00:00:00.000Z',
    to: '2026-06-30T23:59:59.999Z',
  });
});

test('a `to` date includes events on that day, rather than stopping at midnight', async (t) => {
  const app = await serverWith();
  t.after(() => app.close());

  await createEvent(app, { title: 'Late on the last day', start: '2026-06-30T18:00:00Z' });

  const body = (
    await app.inject({
      method: 'GET',
      url: '/api/widgets/calendar/events?from=2026-06-01&to=2026-06-30',
    })
  ).json();

  // `to=2026-06-30` meaning "up to 00:00 on the 30th" would silently drop
  // everything that day — the opposite of what anyone means by it.
  assert.equal(body.events.length, 1);
});

test('an event straddling the window boundary is included, not dropped', async (t) => {
  const app = await serverWith();
  t.after(() => app.close());

  await createEvent(app, {
    title: 'Conference',
    allDay: true,
    startDate: '2026-05-28',
    endDate: '2026-06-03',
  });

  const body = (
    await app.inject({
      method: 'GET',
      url: '/api/widgets/calendar/events?from=2026-06-01&to=2026-06-30',
    })
  ).json();

  // Overlap, not "starts within": an event running across the boundary is
  // happening during the window.
  assert.equal(body.events.length, 1, 'a straddling event was dropped from the range');
});

test('a malformed range is refused rather than silently ignored', async (t) => {
  const app = await serverWith();
  t.after(() => app.close());

  const bad = await app.inject({
    method: 'GET',
    url: '/api/widgets/calendar/events?from=whenever',
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'INVALID_RANGE');

  const backwards = await app.inject({
    method: 'GET',
    url: '/api/widgets/calendar/events?from=2026-07-01&to=2026-06-01',
  });
  assert.equal(backwards.statusCode, 400);
});

test('the widget route shows local events even with no feed configured', async (t) => {
  const app = await serverWith();
  t.after(() => app.close());

  // With no feeds and no events, this is genuinely unconfigured.
  const empty = (await app.inject({ method: 'GET', url: '/api/widgets/calendar' })).json();
  assert.equal(empty.configured, false);

  await createEvent(app, { title: 'Local only', start: `${soon(2)}T09:00:00Z` });

  // With an event in it, it is a working calendar — showing the "set
  // HAVEN_CALENDAR_ICS_URL" hint here would be telling the user their own
  // event does not exist.
  const populated = (await app.inject({ method: 'GET', url: '/api/widgets/calendar' })).json();
  assert.equal(populated.configured, true);
  assert.deepEqual(
    populated.events.map((event) => event.title),
    ['Local only']
  );
});

// ── Nothing leaks ────────────────────────────────────────────────────────

test('no response from the merged view carries a feed URL', async (t) => {
  const app = await serverWith({
    icsUrl: `Ope|${FAKE_FEED_URL},Tomi|${SECOND_FEED_URL}`,
    routes: new Map([
      [FAKE_FEED_URL, () => icsResponse(SAMPLE_ICS)],
      [SECOND_FEED_URL, () => icsResponse(SAMPLE_ICS)],
    ]),
  });
  t.after(() => app.close());

  const raw = (await app.inject({ method: 'GET', url: '/api/widgets/calendar/events' })).body;

  // The ICS URL is a bearer credential. The new endpoint is a new way for one
  // to escape, so it gets the same tripwire the widget route has.
  assert.ok(!raw.includes('calendar.invalid'), 'the merged view leaked a feed host');
  assert.ok(!raw.includes('other-calendar.invalid'), 'the merged view leaked a feed host');
  assert.ok(!raw.includes('placeholder'), 'the merged view leaked a secret path segment');
});
