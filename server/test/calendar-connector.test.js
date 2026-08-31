import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCalendarConnector,
  parseFeedConfig,
  redactUrl,
  redactError,
} from '../src/connectors/calendar.js';
import {
  SAMPLE_ICS,
  EMPTY_ICS,
  FAKE_FEED_URL,
  SECOND_FEED_URL,
  createFakeFetch,
  icsResponse,
} from './helpers/ics-fixtures.js';

/**
 * A fixed clock. The fixtures sit in June 2026, so "now" is placed just
 * before them and the default window reaches them.
 */
const NOW = Date.parse('2026-06-01T00:00:00Z');

function connectorFor(routes, overrides = {}) {
  const fetchImpl = createFakeFetch(routes);
  const connector = createCalendarConnector({
    icsUrl: FAKE_FEED_URL,
    fetchImpl,
    now: () => NOW,
    ...overrides,
  });
  return { connector, fetchImpl };
}

const okRoute = (body, opts) => new Map([[FAKE_FEED_URL, () => icsResponse(body, opts)]]);

// ── Feed configuration ───────────────────────────────────────────────────

test('a bare URL parses as one feed', () => {
  const feeds = parseFeedConfig(FAKE_FEED_URL);
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].url, FAKE_FEED_URL);
  assert.equal(feeds[0].name, 'Calendar');
  assert.equal(feeds[0].id, 'feed-1');
});

test('a Name|url list parses as several named feeds', () => {
  const feeds = parseFeedConfig(`Personal|${FAKE_FEED_URL},Work|${SECOND_FEED_URL}`);
  assert.deepEqual(
    feeds.map((f) => [f.id, f.name, f.url]),
    [
      ['feed-1', 'Personal', FAKE_FEED_URL],
      ['feed-2', 'Work', SECOND_FEED_URL],
    ]
  );
});

test('a feed id is positional and never derived from the URL', () => {
  // An id ends up in the DOM and in event ids, so a URL-derived one would
  // leak path segments of a bearer credential into the browser.
  const [feed] = parseFeedConfig(FAKE_FEED_URL);
  assert.equal(feed.id, 'feed-1');
  assert.ok(!feed.id.includes('calendar.invalid'));
  assert.ok(!feed.name.includes('calendar.invalid'));
});

test('an unnamed multi-feed list still gets distinguishable names', () => {
  const feeds = parseFeedConfig(`${FAKE_FEED_URL},${SECOND_FEED_URL}`);
  assert.deepEqual(
    feeds.map((f) => f.name),
    ['Calendar 1', 'Calendar 2']
  );
});

test('a malformed entry is skipped without disabling the others', () => {
  const feeds = parseFeedConfig(`not-a-url,Work|${SECOND_FEED_URL}`);
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].url, SECOND_FEED_URL);
});

test('a non-http scheme is rejected', () => {
  assert.deepEqual(parseFeedConfig('file:///etc/passwd'), []);
  assert.deepEqual(parseFeedConfig('javascript:alert(1)'), []);
});

test('empty or absent config yields no feeds', () => {
  assert.deepEqual(parseFeedConfig(''), []);
  assert.deepEqual(parseFeedConfig(undefined), []);
  assert.deepEqual(parseFeedConfig(null), []);
});

// ── Redaction — the security-critical half ───────────────────────────────

test('redactUrl keeps the origin and drops the secret path', () => {
  const redacted = redactUrl('https://calendar.invalid/ical/SUPERSECRET/basic.ics');
  assert.equal(redacted, 'https://calendar.invalid/<redacted>');
  assert.ok(!redacted.includes('SUPERSECRET'));
});

test('redactUrl drops the query string, where other providers put tokens', () => {
  const redacted = redactUrl('https://calendar.invalid/feed?token=SUPERSECRET');
  assert.ok(!redacted.includes('SUPERSECRET'));
});

test('redactUrl says nothing at all about an unparseable value', () => {
  assert.equal(redactUrl('not a url but maybe a secret'), '<redacted>');
  assert.equal(redactUrl(''), '<redacted>');
  assert.equal(redactUrl(null), '<redacted>');
});

test('redactError scrubs a URL that upstream embedded in its message', () => {
  // This is the real leak path: undici puts the full URL in a fetch failure.
  const error = new Error(
    'request to https://calendar.invalid/ical/SUPERSECRET/basic.ics failed, reason: ECONNREFUSED'
  );
  const message = redactError(error);
  assert.ok(!message.includes('SUPERSECRET'), `leaked the secret path: ${message}`);
  assert.ok(message.includes('ECONNREFUSED'), 'the useful part should survive');
});

// ── Fetch, cache and the soft-notice path ────────────────────────────────

test('an unconfigured connector reports so rather than erroring', async () => {
  const connector = createCalendarConnector({ icsUrl: '', fetchImpl: createFakeFetch() });
  const result = await connector.getEvents();
  assert.equal(result.configured, false);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.problems, []);
});

test('a configured feed returns merged, sorted events', async () => {
  const { connector } = connectorFor(okRoute(SAMPLE_ICS));
  const result = await connector.getEvents();

  assert.equal(result.configured, true);
  assert.ok(result.events.length > 0);
  assert.equal(result.stale, false);
  assert.deepEqual(result.problems, []);
});

test('events from several feeds are merged and attributed to their feed', async () => {
  const routes = new Map([
    [FAKE_FEED_URL, () => icsResponse(SAMPLE_ICS)],
    [SECOND_FEED_URL, () => icsResponse(SAMPLE_ICS)],
  ]);
  const { connector } = connectorFor(routes, {
    icsUrl: `Personal|${FAKE_FEED_URL},Work|${SECOND_FEED_URL}`,
  });

  const result = await connector.getEvents();
  const feedIds = new Set(result.events.map((e) => e.feedId));
  assert.deepEqual([...feedIds].sort(), ['feed-1', 'feed-2']);
  assert.ok(result.events.every((e) => e.feedName === 'Personal' || e.feedName === 'Work'));
});

test('a second call inside the cache window does not refetch', async () => {
  const { connector, fetchImpl } = connectorFor(okRoute(SAMPLE_ICS));
  await connector.getEvents();
  await connector.getEvents();
  assert.equal(fetchImpl.calls.length, 1, 'calendars change slowly — cache hard');
});

test('force bypasses the cache', async () => {
  const { connector, fetchImpl } = connectorFor(okRoute(SAMPLE_ICS));
  await connector.getEvents();
  await connector.getEvents({ force: true });
  assert.equal(fetchImpl.calls.length, 2);
});

test('a refetch sends If-None-Match when the feed gave an ETag', async () => {
  const { connector, fetchImpl } = connectorFor(okRoute(SAMPLE_ICS, { etag: '"abc123"' }));
  await connector.getEvents();
  await connector.getEvents({ force: true });

  assert.equal(fetchImpl.calls[0].headers['If-None-Match'], undefined);
  assert.equal(
    fetchImpl.calls[1].headers['If-None-Match'],
    '"abc123"',
    'an unchanged calendar should cost a round trip, not a re-download'
  );
});

test('a refetch sends If-Modified-Since when the feed gave Last-Modified', async () => {
  const stamp = 'Wed, 27 May 2026 10:00:00 GMT';
  const { connector, fetchImpl } = connectorFor(okRoute(SAMPLE_ICS, { lastModified: stamp }));
  await connector.getEvents();
  await connector.getEvents({ force: true });
  assert.equal(fetchImpl.calls[1].headers['If-Modified-Since'], stamp);
});

test('a 304 keeps the cached events rather than blanking the tile', async () => {
  let call = 0;
  const routes = new Map([
    [
      FAKE_FEED_URL,
      () =>
        call++ === 0
          ? icsResponse(SAMPLE_ICS, { etag: '"v1"' })
          : icsResponse(null, { status: 304 }),
    ],
  ]);
  const { connector } = connectorFor(routes);

  const first = await connector.getEvents();
  const second = await connector.getEvents({ force: true });

  assert.ok(first.events.length > 0);
  assert.equal(second.events.length, first.events.length);
  assert.equal(second.stale, false, '304 means unchanged, not stale');
  assert.deepEqual(second.problems, []);
});

test('a failed refresh over a warm cache is a SOFT NOTICE, not an error', async () => {
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
  const { connector } = connectorFor(routes);

  const first = await connector.getEvents();
  const second = await connector.getEvents({ force: true });

  assert.ok(second.events.length > 0, 'last good data must survive a failed refresh');
  assert.equal(second.events.length, first.events.length);
  assert.equal(second.stale, true, 'and must be marked stale');
  assert.equal(second.problems.length, 1);
});

test('a failing feed with no cache yields a problem and no events', async () => {
  const routes = new Map([
    [
      FAKE_FEED_URL,
      () => {
        throw new Error('ECONNREFUSED');
      },
    ],
  ]);
  const { connector } = connectorFor(routes);

  const result = await connector.getEvents();
  assert.deepEqual(result.events, []);
  assert.equal(result.problems.length, 1);
  assert.equal(result.stale, false);
});

test('one dead feed does not stop a healthy one rendering', async () => {
  const routes = new Map([
    [FAKE_FEED_URL, () => icsResponse(SAMPLE_ICS)],
    [
      SECOND_FEED_URL,
      () => {
        throw new Error('ECONNREFUSED');
      },
    ],
  ]);
  const { connector } = connectorFor(routes, {
    icsUrl: `Personal|${FAKE_FEED_URL},Work|${SECOND_FEED_URL}`,
  });

  const result = await connector.getEvents();
  assert.ok(result.events.length > 0, 'the healthy feed still renders');
  assert.ok(result.events.every((e) => e.feedId === 'feed-1'));
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].feedId, 'feed-2');
});

test('an HTTP error reports the status without the URL or the status text', async () => {
  const routes = new Map([[FAKE_FEED_URL, () => icsResponse('nope', { status: 403 })]]);
  const { connector } = connectorFor(routes);

  const result = await connector.getEvents();
  assert.equal(result.problems.length, 1);
  assert.ok(result.problems[0].message.includes('403'));
  assert.ok(!result.problems[0].message.includes('calendar.invalid'));
});

test('NO problem message ever contains the feed URL', async () => {
  // The single assertion that matters most: every failure mode at once,
  // checked against the secret path segment.
  const failures = [
    () => {
      throw new Error(`request to ${FAKE_FEED_URL} failed, reason: ECONNREFUSED`);
    },
    () => icsResponse('nope', { status: 500 }),
    () => icsResponse('this is not a calendar', { status: 200 }),
    () => icsResponse('', { status: 200 }),
  ];

  for (const handler of failures) {
    const { connector } = connectorFor(new Map([[FAKE_FEED_URL, handler]]));
    const result = await connector.getEvents();
    for (const problem of result.problems) {
      assert.ok(
        !problem.message.includes('placeholder'),
        `problem message leaked the feed path: ${problem.message}`
      );
      assert.ok(
        !problem.message.includes(FAKE_FEED_URL),
        `problem message leaked the feed URL: ${problem.message}`
      );
    }
  }
});

test('the connector never exposes a feed URL on its feed list', async () => {
  const { connector } = connectorFor(okRoute(SAMPLE_ICS));
  const result = await connector.getEvents();

  for (const feed of [...connector.feeds, ...result.feeds]) {
    assert.deepEqual(Object.keys(feed).sort(), ['id', 'name']);
    assert.ok(!JSON.stringify(feed).includes('calendar.invalid'));
  }
});

test('an empty calendar is an empty list, not a problem', async () => {
  const { connector } = connectorFor(okRoute(EMPTY_ICS));
  const result = await connector.getEvents();

  assert.equal(result.configured, true);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.problems, [], 'a quiet week is not a failure');
});

test('an oversized feed is refused by its declared length', async () => {
  const routes = new Map([
    [
      FAKE_FEED_URL,
      () => ({
        ok: true,
        status: 200,
        headers: {
          get: (n) => (n.toLowerCase() === 'content-length' ? String(9 * 1024 * 1024) : null),
        },
        text: async () => 'should never be read',
      }),
    ],
  ]);
  const { connector } = connectorFor(routes);

  const result = await connector.getEvents();
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0].message, /too large/i);
});
