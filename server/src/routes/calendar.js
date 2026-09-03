/**
 * Calendar widget API — `GET /api/widgets/calendar`.
 *
 * The browser never holds an ICS URL, so this route is the whole of its
 * access to a calendar. What it returns is deliberately narrow: normalised
 * events plus feed labels, and nothing that could reconstruct a feed address.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The ICS URL is a BEARER CREDENTIAL — holding one grants read access to the
 * entire calendar. So nothing here returns a feed URL: the response carries
 * `{ id, name }` per feed and event fields only, and feed ids are positional
 * (`feed-1`) rather than derived from the URL. The connector redacts every
 * error before it gets here; see `server/src/connectors/calendar.js` and the
 * tripwire at `server/test/calendar-redaction-tripwire.test.js`.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The same notice/error split as the weather and torrents routes
 * (docs/WIDGET-CONTRACT.md — *a soft notice is not a hard error*):
 *
 *   configured, events        -> 200, the list
 *   not configured            -> 200, `configured: false` and a setup hint
 *   refresh failed + cache    -> 200, the last good list + `stale: true`
 *   every feed down, no cache -> 502, because an empty list here would read
 *                                as "nothing coming up", which is a lie
 */

import { calendarConnectorFromConfig } from '../connectors/calendar.js';
import { sortEvents } from '../connectors/ics-parse.js';
import { listEvents, MAX_EVENTS } from '../db/calendar-store.js';
import { LOCAL_SOURCE } from '../calendar/event-envelope.js';

/** How far the merged read reaches when the caller names no window. */
const DEFAULT_PAST_DAYS = 1;
const DEFAULT_FUTURE_DAYS = 60;
const DAY_MS = 86_400_000;

/**
 * Parse a `from`/`to` query parameter.
 *
 * Accepts a date (`2026-06-12`) or a full instant, because a caller asking
 * "what is on next week" naturally sends dates. A date is widened to cover
 * the whole day — `to=2026-06-12` meaning "up to the start of the 12th" would
 * silently drop everything happening on the 12th, which is the opposite of
 * what anyone means by it.
 *
 * @returns {{ value: string|null, error: string|null }}
 */
export function parseRangeBound(raw, field, { endOfDay = false } = {}) {
  if (raw === undefined || raw === null || raw === '') return { value: null, error: null };
  if (typeof raw !== 'string') {
    return { value: null, error: `${field} must be a date or ISO-8601 timestamp.` };
  }

  const trimmed = raw.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { value: `${trimmed}T${endOfDay ? '23:59:59.999Z' : '00:00:00.000Z'}`, error: null };
  }

  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    return {
      value: null,
      error: `${field} must be "YYYY-MM-DD" or an ISO-8601 timestamp (got "${trimmed}").`,
    };
  }
  return { value: new Date(timestamp).toISOString(), error: null };
}

/**
 * Does an ICS-sourced event fall inside `[from, to]`?
 *
 * The store does this in SQL for local events; feed events are already in
 * memory, so the same overlap rule is applied here. OVERLAP, not "starts
 * within" — an event running across the window boundary is happening during
 * it, and dropping it would lose exactly the entries a dashboard most needs.
 */
function overlapsWindow(event, from, to) {
  // An all-day event is a date; widen it to cover its whole last day so a
  // window opening mid-morning still contains it.
  const start = event.allDay ? `${event.startDate}T00:00:00.000Z` : event.start;
  const end = event.allDay
    ? `${event.endDate ?? event.startDate}T23:59:59.999Z`
    : (event.end ?? event.start);

  if (from && end < from) return false;
  if (to && start > to) return false;
  return true;
}

export async function registerCalendarRoutes(app, { connector, db: providedDb, ...options } = {}) {
  // Injectable so a test can drive the route from a stubbed ICS feed and
  // never touch the network — no test needs a real feed URL.
  const calendar = connector ?? calendarConnectorFromConfig({ logger: app.log, ...options });

  /**
   * The local store is optional at this seam: the widget route predates it,
   * and a test that only cares about feed behaviour should not have to stand
   * up a database. Resolved per request rather than captured, because
   * `app.db` is decorated after this plugin registers in some orderings.
   */
  const database = () => providedDb ?? app.db ?? null;

  /**
   * The merged view — read-only ICS feeds plus Haven's own events.
   *
   * One list, one shape, sorted together. `source` is what distinguishes
   * them: `"local"` for events Haven stores (and can therefore edit),
   * `"feed"` for everything that arrived over an iCal address and is
   * consequently read-only. A calling agent needs exactly that to know which
   * ids it may PATCH, which is why it is on every event rather than implied
   * by the id prefix alone.
   */
  async function mergedEvents({ force, from, to, nowMs }) {
    const result = await calendar.getEvents({ force });

    const feedEvents = result.events
      .filter((event) => overlapsWindow(event, from, to))
      // Feed events are stamped here rather than in the parser so that
      // `ics-parse.js` stays a pure ICS concern and has no opinion about an
      // API that did not exist when it was written.
      .map((event) => ({ ...event, source: 'feed', editable: false }));

    const db = database();
    const localEvents = db
      ? listEvents(db, {
          from: from ?? new Date(nowMs - DEFAULT_PAST_DAYS * DAY_MS).toISOString(),
          to: to ?? new Date(nowMs + DEFAULT_FUTURE_DAYS * DAY_MS).toISOString(),
          limit: MAX_EVENTS,
        }).map((event) => ({ ...event, editable: true }))
      : [];

    return {
      ...result,
      events: sortEvents([...feedEvents, ...localEvents]),
      // The local store is presented as a feed of its own so the widget's
      // existing per-feed colouring labels it without a special case.
      // Exactly `{ id, name }`, like every other feed. The shape is pinned
      // by a test precisely because a wider one is how a feed URL would
      // eventually leak into the browser — so the local store gets no extra
      // key here. The widget tells local events apart by `event.source`,
      // which it needs anyway to know what it may offer to edit.
      feeds: [...result.feeds, ...(db ? [{ id: LOCAL_SOURCE, name: 'Haven' }] : [])],
    };
  }

  /**
   * GET /api/widgets/calendar — what the widget renders.
   *
   * Now a MERGED view: read-only ICS feeds plus Haven's own local events.
   *
   * "Configured" changed meaning when the local store arrived, and the change
   * is deliberate. It used to mean "an ICS feed is set", because a feed was
   * the only possible source of an event. A local calendar is a source too,
   * so a deployment with no feeds but with events in it is configured — and
   * showing it the "set HAVEN_CALENDAR_ICS_URL" hint tile instead of the
   * events it can plainly see created would be simply wrong.
   */
  app.get('/api/widgets/calendar', async (request, reply) => {
    const force = request.query?.force === '1' || request.query?.force === 'true';
    const nowMs = Date.now();
    const db = database();

    if (!calendar.isConfigured()) {
      // No feeds. There may still be local events, and if there are, this is
      // a working calendar rather than an unconfigured one.
      const localEvents = db
        ? listEvents(db, {
            from: new Date(nowMs - DEFAULT_PAST_DAYS * DAY_MS).toISOString(),
            to: new Date(nowMs + DEFAULT_FUTURE_DAYS * DAY_MS).toISOString(),
          }).map((event) => ({ ...event, editable: true }))
        : [];

      reply.header('cache-control', 'no-store');

      if (localEvents.length === 0) {
        // 200: an unconfigured connector is a normal state on a fresh
        // install, and a tile the user can act on beats an error they cannot.
        return {
          configured: false,
          events: [],
          feeds: [],
          problems: [],
          stale: false,
          hint: 'Set HAVEN_CALENDAR_ICS_URL to a calendar’s secret iCal address.',
        };
      }

      return {
        configured: true,
        events: sortEvents(localEvents),
        feeds: [{ id: LOCAL_SOURCE, name: 'Haven' }],
        problems: [],
        stale: false,
        fetchedAt: new Date(nowMs).toISOString(),
      };
    }

    let result;
    try {
      result = await mergedEvents({ force, from: null, to: null, nowMs });
    } catch (error) {
      // The connector redacts at its own choke point on every path that can
      // carry a URL, so reaching here is unexpected. Log it, return none of it.
      app.log.error({ err: error }, 'Calendar connector failed unexpectedly');
      reply.header('cache-control', 'no-store');
      return reply
        .code(500)
        .send({ error: 'CALENDAR_FAILED', message: 'Could not load the calendar.' });
    }

    if (result.events.length === 0 && result.problems.length > 0 && !result.stale) {
      // Every feed is down AND there is nothing local to show. An empty list
      // here would read as "nothing coming up", which is a lie.
      reply.header('cache-control', 'no-store');
      return reply.code(502).send({
        error: 'CALENDAR_UNAVAILABLE',
        message: 'No calendar feed could be reached.',
        problems: result.problems,
        configured: true,
        events: [],
        feeds: result.feeds,
        stale: false,
      });
    }

    // Calendars change slowly, so let the browser honour a window of its own —
    // but never cache stale data, so recovery is immediate. A local write must
    // also show up on the next poll, so anything with local events is
    // no-store: a 5-minute cached response would make a just-created event
    // appear to have silently failed.
    const hasLocal = result.events.some((event) => event.source === LOCAL_SOURCE);
    reply.header('cache-control', result.stale || hasLocal ? 'no-store' : 'private, max-age=300');

    return {
      configured: true,
      events: result.events,
      feeds: result.feeds,
      problems: result.problems,
      stale: result.stale,
      fetchedAt: new Date(result.fetchedAt ?? nowMs).toISOString(),
    };
  });

  /**
   * GET /api/widgets/calendar/events — the merged view, with a date range.
   *
   * The same data as the route above, but windowed, and shaped for a calling
   * agent rather than for the tile: `?from=2026-06-01&to=2026-06-30`.
   *
   * It is a separate route rather than a query parameter on the widget one
   * because the two have different contracts. The widget route is allowed to
   * degrade — stale data, a hint tile, a soft notice — because a dashboard
   * that renders something beats one that renders an error. An agent asking
   * for a date range wants an answer or a failure, and quietly serving it
   * fifteen-minute-old data as though it were current would be the wrong
   * trade for something about to write to that same calendar.
   */
  app.get('/api/widgets/calendar/events', async (request, reply) => {
    const from = parseRangeBound(request.query?.from, 'from');
    const to = parseRangeBound(request.query?.to, 'to', { endOfDay: true });

    const errors = [from, to].filter((bound) => bound.error).map((bound) => bound.error);
    if (errors.length > 0) {
      return reply.code(400).send({ error: 'INVALID_RANGE', message: errors.join(' ') });
    }

    if (from.value && to.value && to.value < from.value) {
      return reply.code(400).send({
        error: 'INVALID_RANGE',
        message: `"to" (${to.value}) is before "from" (${from.value}).`,
      });
    }

    const nowMs = Date.now();
    const force = request.query?.force === '1' || request.query?.force === 'true';

    let result;
    try {
      result = await mergedEvents({ force, from: from.value, to: to.value, nowMs });
    } catch (error) {
      app.log.error({ err: error }, 'Calendar connector failed unexpectedly');
      reply.header('cache-control', 'no-store');
      return reply
        .code(500)
        .send({ error: 'CALENDAR_FAILED', message: 'Could not load the calendar.' });
    }

    // Never cached. A caller that just POSTed an event and immediately reads
    // the range back must see it — a cached 200 here would look exactly like
    // a write that silently did nothing.
    reply.header('cache-control', 'no-store');

    return {
      events: result.events,
      feeds: result.feeds,
      // Named, so a caller can tell "no events in June" from "the feed was
      // down and June may well have had some".
      problems: result.problems,
      stale: result.stale,
      range: { from: from.value, to: to.value },
      fetchedAt: new Date(nowMs).toISOString(),
    };
  });
}
