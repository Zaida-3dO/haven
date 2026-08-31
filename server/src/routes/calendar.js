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

export async function registerCalendarRoutes(app, { connector, ...options } = {}) {
  // Injectable so a test can drive the route from a stubbed ICS feed and
  // never touch the network — no test needs a real feed URL.
  const calendar = connector ?? calendarConnectorFromConfig({ logger: app.log, ...options });

  app.get('/api/widgets/calendar', async (request, reply) => {
    if (!calendar.isConfigured()) {
      // 200: an unconfigured connector is a normal state on a fresh install,
      // and a tile the user can act on beats an error they cannot.
      reply.header('cache-control', 'no-store');
      return {
        configured: false,
        events: [],
        feeds: [],
        problems: [],
        stale: false,
        hint: 'Set HAVEN_CALENDAR_ICS_URL to a calendar’s secret iCal address.',
      };
    }

    const force = request.query?.force === '1' || request.query?.force === 'true';

    let result;
    try {
      result = await calendar.getEvents({ force });
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
    // but never cache stale data, so recovery is immediate.
    reply.header('cache-control', result.stale ? 'no-store' : 'private, max-age=300');

    return {
      configured: true,
      events: result.events,
      feeds: result.feeds,
      problems: result.problems,
      stale: result.stale,
      fetchedAt: new Date(result.fetchedAt).toISOString(),
    };
  });
}
