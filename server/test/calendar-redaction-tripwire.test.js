/**
 * TRIPWIRE — the ICS URL must never escape the connector.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS FOR, AND WHY IT IS SEPARATE
 *
 * A calendar's "secret address in iCal format" is a BEARER CREDENTIAL:
 * holding it grants read access to the entire calendar, forever, with no
 * authentication and no way to tell it is being used. It is exactly as
 * sensitive as a password — and it arrives in the one place people do not
 * treat as secret, a URL.
 *
 * That makes the dangerous paths the ones that are normally harmless: error
 * messages and log lines. `fetch`/undici embeds the full URL in its failure
 * message by default, so the natural thing to write —
 *
 *     catch (error) { app.log.error(`fetch failed: ${feed.url}`); }
 *     catch (error) { throw new Error(`could not reach ${feed.url}`); }
 *
 * — silently publishes a working credential into a log aggregator, a browser
 * error tile, or a pasted bug report. Nothing else in the suite would fail.
 *
 * So this is a NAMED TRIPWIRE rather than an assertion buried in a
 * behavioural test, in the same spirit as the search index's in-memory-only
 * guard: it exists to fail loudly when a future change reintroduces the leak,
 * and its name should make the reason obvious in a CI log.
 *
 * The token below is invented, and the host is `.invalid` (RFC 2606, cannot
 * resolve). No real feed, no real credential, no network.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCalendarConnector, redactUrl, redactError } from '../src/connectors/calendar.js';
import { buildServer } from '../src/server.js';
import { SAMPLE_ICS, createFakeFetch, icsResponse } from './helpers/ics-fixtures.js';

/**
 * A distinctive, invented secret. Every assertion below hunts for this exact
 * string, so a leak through any channel is unambiguous.
 */
const SECRET = 'tripwire-s3cr3t-do-not-leak';
const SECRET_FEED_URL = `https://calendar.invalid/ical/user%40example.invalid/private-${SECRET}/basic.ics`;

/** Collects everything the connector logged, at every level. */
function recordingLogger() {
  const lines = [];
  const record =
    (level) =>
    (...args) => {
      lines.push(`${level} ${args.map((a) => JSON.stringify(a)).join(' ')}`);
    };
  return {
    lines,
    warn: record('warn'),
    error: record('error'),
    info: record('info'),
    debug: record('debug'),
    trace: record('trace'),
    fatal: record('fatal'),
    child() {
      return this;
    },
  };
}

/**
 * Every way a feed can fail. Each is a realistic upstream failure, and each
 * one is a separate opportunity to interpolate the URL into a message.
 */
const FAILURE_MODES = {
  'DNS / connection failure (undici embeds the URL)': () => {
    // This is the shape undici really produces, URL and all.
    throw new TypeError(`fetch failed for ${SECRET_FEED_URL}: getaddrinfo ENOTFOUND`);
  },
  'connection refused': () => {
    throw new Error(`request to ${SECRET_FEED_URL} failed, reason: ECONNREFUSED`);
  },
  'HTTP 401 (a revoked secret address)': () => icsResponse('Unauthorized', { status: 401 }),
  'HTTP 404': () => icsResponse('Not Found', { status: 404 }),
  'HTTP 500': () => icsResponse('Server Error', { status: 500 }),
  'malformed ICS body': () => icsResponse('this is not a calendar at all', { status: 200 }),
  'empty body': () => icsResponse('', { status: 200 }),
  'body echoing the URL back': () =>
    // A feed whose own error page quotes the address it was fetched from.
    icsResponse(`<html>Could not load ${SECRET_FEED_URL}</html>`, { status: 200 }),
  'timeout / abort': () => {
    const error = new Error(`The operation was aborted: ${SECRET_FEED_URL}`);
    error.name = 'AbortError';
    throw error;
  },
  'oversized feed': () => ({
    ok: true,
    status: 200,
    headers: {
      get: (n) => (n.toLowerCase() === 'content-length' ? String(50 * 1024 * 1024) : null),
    },
    text: async () => '',
  }),
};

/** Assert the secret is absent from an arbitrary blob of text. */
function assertNoSecret(text, context) {
  assert.ok(
    !text.includes(SECRET),
    `SECRET LEAKED via ${context}.\nThe ICS URL is a bearer credential and must never appear here.\nGot: ${text}`
  );
}

// ── The tripwire itself ─────────────────────────────────────────────────

for (const [name, handler] of Object.entries(FAILURE_MODES)) {
  test(`TRIPWIRE: the ICS secret never leaks — ${name}`, async () => {
    const logger = recordingLogger();
    const connector = createCalendarConnector({
      icsUrl: SECRET_FEED_URL,
      fetchImpl: createFakeFetch(new Map([[SECRET_FEED_URL, handler]])),
      logger,
      now: () => Date.parse('2026-06-01T00:00:00Z'),
    });

    const result = await connector.getEvents();

    // 1. Not in any problem message handed back to the caller.
    for (const problem of result.problems) {
      assertNoSecret(problem.message, `problem.message (${name})`);
    }

    // 2. Not in the serialised result — which is what the route returns.
    assertNoSecret(JSON.stringify(result), `the serialised connector result (${name})`);

    // 3. Not in anything logged.
    assertNoSecret(logger.lines.join('\n'), `a log line (${name})`);
  });
}

test('TRIPWIRE: the secret never leaks through the HTTP response body', async (t) => {
  const logger = recordingLogger();
  const app = await buildServer({
    dbPath: ':memory:',
    logger: false,
    seedPath: 'config/does-not-exist.json',
    widgets: {
      calendarConnector: createCalendarConnector({
        icsUrl: SECRET_FEED_URL,
        fetchImpl: createFakeFetch(
          new Map([
            [
              SECRET_FEED_URL,
              () => {
                throw new TypeError(`fetch failed for ${SECRET_FEED_URL}`);
              },
            ],
          ])
        ),
        logger,
        now: () => Date.parse('2026-06-01T00:00:00Z'),
      }),
    },
  });
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/widgets/calendar' });

  // Whatever the status, the body must not carry the credential.
  assertNoSecret(response.body, 'the HTTP response body');
  assertNoSecret(JSON.stringify(response.headers), 'a response header');
  assertNoSecret(logger.lines.join('\n'), 'a log line during the request');
});

test('TRIPWIRE: a SUCCESSFUL response carries no trace of the feed URL either', async (t) => {
  const app = await buildServer({
    dbPath: ':memory:',
    logger: false,
    seedPath: 'config/does-not-exist.json',
    widgets: {
      calendarConnector: createCalendarConnector({
        icsUrl: SECRET_FEED_URL,
        fetchImpl: createFakeFetch(new Map([[SECRET_FEED_URL, () => icsResponse(SAMPLE_ICS)]])),
        now: () => Date.parse('2026-06-01T00:00:00Z'),
      }),
    },
  });
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/widgets/calendar' });
  assert.equal(response.statusCode, 200);

  // The happy path is easy to forget: feed ids and names are returned, and a
  // URL-derived id or label would leak just as effectively as an error would.
  assertNoSecret(response.body, 'a successful response body');
  assert.ok(!response.body.includes('calendar.invalid'), 'the feed host must not be returned');
  assert.ok(!response.body.includes('basic.ics'), 'the feed path must not be returned');
});

test('TRIPWIRE: redactUrl and redactError strip the secret directly', () => {
  // The two choke points every error path is routed through.
  assertNoSecret(redactUrl(SECRET_FEED_URL), 'redactUrl');
  assertNoSecret(
    redactError(new Error(`request to ${SECRET_FEED_URL} failed`)),
    'redactError on a wrapping message'
  );
  // A message with the URL buried mid-sentence, which a regex could miss.
  assertNoSecret(
    redactError(new Error(`upstream said ${SECRET_FEED_URL} was bad, retrying`)),
    'redactError on an embedded URL'
  );
});

test('TRIPWIRE: redaction keeps the diagnosable part of the error', () => {
  // A guard that redacted everything would pass the tests above while making
  // the logs useless, so pin the useful half too.
  const message = redactError(new Error(`request to ${SECRET_FEED_URL} failed: ECONNREFUSED`));
  assert.match(message, /ECONNREFUSED/);
  assert.match(message, /calendar\.invalid/, 'the origin is safe and worth keeping');
});

/**
 * A note on why there is exactly ONE redaction point in the connector.
 *
 * The first version of this scrubbed twice — once in `fetchFeed` as it
 * wrapped a transport failure, and once in `loadFeed` on the way out. That
 * looked like defence in depth, but mutation testing showed it was the
 * opposite: with two scrubs, deleting EITHER one left every test in this file
 * green, because the survivor still cleaned the message. A duplicated guard
 * had made the guard untestable.
 *
 * So redaction now happens in one place, `loadFeed`'s catch, which every
 * error path funnels through. Deleting it fails five of these tests by name,
 * and reintroducing the classic regression — logging `feed.url` — fails
 * eleven.
 */
test('TRIPWIRE: an error from the parse stage is redacted, not just transport errors', async () => {
  // `ical.js` is third-party: it can throw whatever it likes, including a
  // message quoting the content it choked on. The outer scrub is what
  // contains anything the fetch layer never saw.
  const connector = createCalendarConnector({
    icsUrl: SECRET_FEED_URL,
    fetchImpl: async () => {
      throw new Error(`parser blew up on ${SECRET_FEED_URL}`);
    },
    now: () => Date.parse('2026-06-01T00:00:00Z'),
  });

  const { problems } = await connector.getEvents();
  assert.equal(problems.length, 1);
  assertNoSecret(problems.map((p) => p.message).join('\n'), 'a problem from the parse stage');
});

test('TRIPWIRE: the connector never returns a feed URL, even on success', async () => {
  const connector = createCalendarConnector({
    icsUrl: SECRET_FEED_URL,
    fetchImpl: createFakeFetch(new Map([[SECRET_FEED_URL, () => icsResponse(SAMPLE_ICS)]])),
    now: () => Date.parse('2026-06-01T00:00:00Z'),
  });

  const result = await connector.getEvents();
  // Pin the SHAPE, not just the absence of this one token: a feed object that
  // grew a `url` key would leak every future secret, whatever it contained.
  for (const feed of [...connector.feeds, ...result.feeds]) {
    assert.deepEqual(
      Object.keys(feed).sort(),
      ['id', 'name'],
      'a feed handed outward carries id and name ONLY — never a url'
    );
  }
});
