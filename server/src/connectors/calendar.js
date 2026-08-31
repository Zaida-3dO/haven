/**
 * The calendar connector — ICS feeds in, normalised events out.
 *
 * Read-only, and deliberately NOT OAuth. A Google Calendar "secret address in
 * iCal format" needs one HTTP GET and a parse; OAuth is a token dance, a
 * refresh loop and a consent screen for capabilities (writing events) nothing
 * here wants. If write access is ever needed, that is the moment to add it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SECURITY — THE ICS URL IS A BEARER CREDENTIAL
 *
 * Anyone holding the secret address can read the entire calendar, forever,
 * without authenticating. It is exactly as sensitive as a password, and it
 * arrives in a place people do not think of as secret: a URL.
 *
 * That makes URLs dangerous in the ONE place URLs are normally safe — error
 * messages and logs. `fetch` failures quote the URL by default
 * (`TypeError: fetch failed ... https://calendar.google.com/.../secret/basic.ics`),
 * and that string then lands in a log aggregator, an error tile in the
 * browser, or a bug report. So:
 *
 *   - `redactUrl()` is applied to EVERY error before it leaves this module,
 *     and every log line names a feed by its id, never its URL.
 *   - The route never returns a feed URL to the browser.
 *   - Feed ids and names are derived from config, never from the URL, so a
 *     display label cannot leak a path segment.
 *
 * `redactError` is the single choke point; if you add an error path, route it
 * through that rather than re-deriving the rule.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { config } from '../config.js';
import { parseIcs, sortEvents, IcsParseError } from './ics-parse.js';

/** Calendars change slowly; a long cache is correct, not a compromise. */
export const DEFAULT_CACHE_MS = 15 * 60_000;

/** How far back and forward the normalised window reaches. */
const DEFAULT_PAST_DAYS = 1;
const DEFAULT_FUTURE_DAYS = 60;

/** A feed that does not answer in this long is treated as down. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Refuse absurd payloads rather than parsing them into memory. */
const MAX_FEED_BYTES = 5 * 1024 * 1024;

const DAY_MS = 86_400_000;

export class CalendarError extends Error {
  constructor(message, code = 'CALENDAR_ERROR') {
    super(message);
    this.name = 'CalendarError';
    this.code = code;
  }
}

/**
 * Strip everything identifying from a URL, leaving only the origin.
 *
 * The secret in a Google ICS address lives in the PATH
 * (`/calendar/ical/<address>/private-<secret>/basic.ics`), and query strings
 * carry tokens on other providers, so both go. The origin is kept because
 * "couldn't reach calendar.google.com" is a genuinely useful thing to be told
 * and gives nothing away.
 */
export function redactUrl(value) {
  if (typeof value !== 'string' || value === '') return '<redacted>';
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/<redacted>`;
  } catch {
    // Not parseable as a URL — it could be anything, so say nothing about it.
    return '<redacted>';
  }
}

/**
 * Scrub any URL out of an error message.
 *
 * Belt and braces on top of never interpolating a URL ourselves: the message
 * may have come from `fetch`/undici, which embeds the full URL it tried. A
 * regex over the message is the only way to catch what we did not write.
 */
export function redactError(error, feedId = null) {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = raw.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (match) => redactUrl(match));
  return feedId ? `${feedId}: ${scrubbed}` : scrubbed;
}

/**
 * Parse the configured feed list.
 *
 * A LIST, not a single URL, from the start. Whether this ends up merging one
 * calendar or several is still open (DESIGN §6.4), and supporting a list now
 * costs nothing while making the answer a config change instead of a rewrite.
 *
 * Two accepted forms, so the common case stays trivial:
 *
 *   HAVEN_CALENDAR_ICS_URL=https://host.invalid/one.ics
 *   HAVEN_CALENDAR_ICS_URL=Personal|https://a.invalid/a.ics,Work|https://b.invalid/b.ics
 *
 * The `Name|url` form is what makes several feeds distinguishable in the tile
 * without the browser ever seeing a URL to derive a label from.
 */
export function parseFeedConfig(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];

  const feeds = [];
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  entries.forEach((entry, index) => {
    const separator = entry.indexOf('|');
    const hasName = separator > 0;
    const name = hasName ? entry.slice(0, separator).trim() : '';
    const url = (hasName ? entry.slice(separator + 1) : entry).trim();

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      // Skip rather than throw: one malformed feed must not disable the
      // others, and the message must not quote the value (it may BE a URL).
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;

    feeds.push({
      // Positional, never derived from the URL — an id ends up in the DOM as
      // a CSS class and in event ids, and a URL-derived one would leak.
      id: `feed-${index + 1}`,
      name: name || (entries.length === 1 ? 'Calendar' : `Calendar ${index + 1}`),
      url,
    });
  });

  return feeds;
}

/** Is the calendar connector configured at all? */
export function isConfigured(feeds) {
  return Array.isArray(feeds) && feeds.length > 0;
}

/**
 * Fetch one feed, honouring HTTP validators.
 *
 * `ETag`/`Last-Modified` are the whole reason a 15-minute cache is cheap: a
 * revalidation of an unchanged calendar is a 304 with no body, so polling
 * costs a round trip rather than a re-download and a re-parse. Google's ICS
 * endpoint serves both.
 *
 * @returns {{ notModified: boolean, text?: string, etag?: string, lastModified?: string }}
 */
async function fetchFeed(feed, cached, { fetchImpl, timeoutMs, signal }) {
  const headers = { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' };
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });

  let response;
  try {
    response = await fetchImpl(feed.url, {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (error) {
    // NEVER let this through unredacted — undici puts the full URL in it.
    throw new CalendarError(redactError(error), 'FEED_UNREACHABLE');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }

  if (response.status === 304) return { notModified: true };

  if (!response.ok) {
    // Status only. The status text is upstream-controlled and the URL is
    // secret, so neither is interpolated.
    throw new CalendarError(`Calendar feed responded ${response.status}.`, 'FEED_HTTP_ERROR');
  }

  const declaredLength = Number(response.headers?.get?.('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FEED_BYTES) {
    throw new CalendarError('Calendar feed is too large to parse.', 'FEED_TOO_LARGE');
  }

  const text = await response.text();
  if (text.length > MAX_FEED_BYTES) {
    throw new CalendarError('Calendar feed is too large to parse.', 'FEED_TOO_LARGE');
  }

  return {
    notModified: false,
    text,
    etag: response.headers?.get?.('etag') ?? null,
    lastModified: response.headers?.get?.('last-modified') ?? null,
  };
}

/**
 * The connector.
 *
 * Holds the per-feed cache (parsed events plus HTTP validators) so a refresh
 * that 304s, or fails outright, can still serve the last good data. That is
 * the soft-notice path: stale data with a marker beats an error box.
 */
export function createCalendarConnector({
  icsUrl = process.env.HAVEN_CALENDAR_ICS_URL,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  cacheMs = DEFAULT_CACHE_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pastDays = DEFAULT_PAST_DAYS,
  futureDays = DEFAULT_FUTURE_DAYS,
  logger = null,
} = {}) {
  const feeds = parseFeedConfig(icsUrl);
  /** feedId -> { events, etag, lastModified, fetchedAt } */
  const cache = new Map();

  /**
   * Fetch and parse one feed, falling back to cache on failure.
   * Never throws: a dead feed becomes a `problem` on the result.
   */
  async function loadFeed(feed, { force, signal }) {
    const cached = cache.get(feed.id) ?? null;
    const fresh = cached && now() - cached.fetchedAt < cacheMs;

    if (fresh && !force) {
      return { feed, events: cached.events, stale: false, problem: null };
    }

    const windowStart = new Date(now() - pastDays * DAY_MS);
    const windowEnd = new Date(now() + futureDays * DAY_MS);

    try {
      const result = await fetchFeed(feed, cached, { fetchImpl, timeoutMs, signal });

      if (result.notModified && cached) {
        // Unchanged upstream: keep the parsed events, restart the cache clock.
        // The window moved, so re-derive it from the cached TEXT if we have
        // it; otherwise the existing events are still within tolerance.
        const events = cached.text
          ? parseIcs(cached.text, feed, { windowStart, windowEnd })
          : cached.events;
        cache.set(feed.id, { ...cached, events, fetchedAt: now() });
        return { feed, events, stale: false, problem: null };
      }

      const events = parseIcs(result.text, feed, { windowStart, windowEnd });
      cache.set(feed.id, {
        events,
        // Kept so a 304 can re-window without a re-fetch. It is calendar
        // content, so it stays in memory on the server and is never persisted.
        text: result.text,
        etag: result.etag,
        lastModified: result.lastModified,
        fetchedAt: now(),
      });
      return { feed, events, stale: false, problem: null };
    } catch (error) {
      const message =
        error instanceof CalendarError || error instanceof IcsParseError
          ? redactError(error)
          : redactError(error);

      // Log by feed id — NEVER the URL.
      logger?.warn?.({ feedId: feed.id }, `Calendar feed failed: ${message}`);

      if (cached) {
        // Soft notice: last good data, marked stale. Not an error box.
        return { feed, events: cached.events, stale: true, problem: message };
      }
      return { feed, events: [], stale: false, problem: message };
    }
  }

  return {
    /** The feeds, WITHOUT their URLs — safe to hand to a route. */
    feeds: feeds.map(({ id, name }) => ({ id, name })),

    isConfigured: () => isConfigured(feeds),

    /**
     * Every feed's events, merged and sorted.
     *
     * Feeds load in parallel and independently: one dead calendar degrades to
     * a notice while the others render normally.
     */
    async getEvents({ force = false, signal = null } = {}) {
      if (!isConfigured(feeds)) {
        return {
          configured: false,
          events: [],
          feeds: [],
          problems: [],
          stale: false,
          fetchedAt: now(),
        };
      }

      const results = await Promise.all(feeds.map((feed) => loadFeed(feed, { force, signal })));

      const events = sortEvents(results.flatMap((r) => r.events));
      const problems = results
        .filter((r) => r.problem)
        .map((r) => ({ feedId: r.feed.id, feedName: r.feed.name, message: r.problem }));

      return {
        configured: true,
        events,
        feeds: feeds.map(({ id, name }) => ({ id, name })),
        problems,
        // Stale means "at least one feed is serving cached data after a
        // failed refresh" — the marker the widget renders.
        stale: results.some((r) => r.stale),
        fetchedAt: now(),
      };
    },

    /** Test/ops seam — drops cached calendar content from memory. */
    clearCache() {
      cache.clear();
    },
  };
}

/** The app-wide connector, configured from the environment. */
export function calendarConnectorFromConfig(overrides = {}) {
  return createCalendarConnector({ icsUrl: config.calendarIcsUrl, ...overrides });
}
