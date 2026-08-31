import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../src/server.js';
import { createCalendarConnector } from '../src/connectors/calendar.js';
import { SAMPLE_ICS, FAKE_FEED_URL, createFakeFetch, icsResponse } from './helpers/ics-fixtures.js';

const NOW = Date.parse('2026-06-01T00:00:00Z');

/**
 * A server whose calendar connector is driven by a stubbed feed.
 *
 * The connector is injected rather than configured from the environment, so
 * no test ever performs a real fetch — which is both faster and the rule
 * (docs/SECURITY.md: never a live feed, never real event data).
 */
async function serverWith(routes, { icsUrl = FAKE_FEED_URL } = {}) {
  const app = await buildServer({
    dbPath: ':memory:',
    logger: false,
    seedPath: 'config/does-not-exist.json',
    calendarConnector: createCalendarConnector({
      icsUrl,
      fetchImpl: createFakeFetch(routes),
      now: () => NOW,
    }),
  });
  return app;
}

const okRoute = (body, opts) => new Map([[FAKE_FEED_URL, () => icsResponse(body, opts)]]);

test('GET /api/widgets/calendar returns normalised events', async (t) => {
  const app = await serverWith(okRoute(SAMPLE_ICS));
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/widgets/calendar' });
  assert.equal(response.statusCode, 200);

  const body = response.json();
  assert.equal(body.configured, true);
  assert.ok(Array.isArray(body.events) && body.events.length > 0);
  assert.equal(body.stale, false);

  const event = body.events[0];
  // The normalised shape the widget renders against.
  for (const key of ['id', 'title', 'allDay', 'feedId', 'feedName']) {
    assert.ok(key in event, `event should carry "${key}"`);
  }
});

test('an unconfigured connector returns 200 with a hint, not an error', async (t) => {
  const app = await serverWith(new Map(), { icsUrl: '' });
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/widgets/calendar' });
  // "Not set up yet" is a state the tile renders, not a failure to report.
  assert.equal(response.statusCode, 200);

  const body = response.json();
  assert.equal(body.configured, false);
  assert.deepEqual(body.events, []);
  assert.ok(typeof body.hint === 'string' && body.hint.length > 0);
});

test('the response never contains a feed URL', async (t) => {
  const app = await serverWith(okRoute(SAMPLE_ICS));
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/widgets/calendar' });
  const raw = response.body;

  // The browser must not be able to reconstruct a bearer credential from
  // anything this route returns.
  assert.ok(!raw.includes(FAKE_FEED_URL), 'response leaked the feed URL');
  assert.ok(!raw.includes('calendar.invalid'), 'response leaked the feed host');
  assert.ok(!raw.includes('placeholder'), 'response leaked the secret path segment');
});

test('feeds are returned as id and name only', async (t) => {
  const app = await serverWith(okRoute(SAMPLE_ICS));
  t.after(() => app.close());

  const body = (await app.inject({ method: 'GET', url: '/api/widgets/calendar' })).json();
  assert.ok(body.feeds.length > 0);
  for (const feed of body.feeds) {
    assert.deepEqual(Object.keys(feed).sort(), ['id', 'name']);
  }
});

test('a failing feed with no cache returns 502 rather than an empty-looking week', async (t) => {
  const routes = new Map([
    [
      FAKE_FEED_URL,
      () => {
        throw new Error(`request to ${FAKE_FEED_URL} failed`);
      },
    ],
  ]);
  const app = await serverWith(routes);
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/widgets/calendar' });
  // An empty list here would read as "nothing coming up", which is a lie.
  assert.equal(response.statusCode, 502);

  const body = response.json();
  assert.equal(body.error, 'CALENDAR_UNAVAILABLE');
  assert.ok(body.problems.length > 0);
  assert.ok(!response.body.includes('placeholder'), 'the 502 must not leak the URL either');
});

test('a stale-but-usable feed returns 200 with a staleness marker', async (t) => {
  let call = 0;
  const routes = new Map([
    [
      FAKE_FEED_URL,
      () => {
        if (call++ === 0) return icsResponse(SAMPLE_ICS);
        throw new Error('ECONNREFUSED');
      },
    ],
  ]);
  const app = await serverWith(routes);
  t.after(() => app.close());

  const first = await app.inject({ method: 'GET', url: '/api/widgets/calendar' });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().stale, false);

  // `force=1` drives a refresh, which now fails over a warm cache.
  const second = await app.inject({ method: 'GET', url: '/api/widgets/calendar?force=1' });
  // Soft notice: still 200, still renders, marked stale.
  assert.equal(second.statusCode, 200);

  const body = second.json();
  assert.equal(body.stale, true);
  assert.ok(body.events.length > 0, 'last good data should still render');
  assert.ok(body.problems.length > 0, 'and the reason should be reported');
});

test('an empty calendar is 200 with no events and no problems', async (t) => {
  const app = await serverWith(
    okRoute('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nEND:VCALENDAR')
  );
  t.after(() => app.close());

  const body = (await app.inject({ method: 'GET', url: '/api/widgets/calendar' })).json();
  assert.equal(body.configured, true);
  assert.deepEqual(body.events, []);
  assert.deepEqual(body.problems, []);
});
