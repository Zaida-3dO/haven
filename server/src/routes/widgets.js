/**
 * Widget data endpoints — `/api/widgets/*`.
 *
 * One route per connector. The browser calls these; the connectors hold the
 * credentials. Nothing under here ever returns a key, a token or an upstream
 * URL, because the whole point of the backend is that the browser never sees
 * one (docs/SECURITY.md).
 */

import { createWeatherConnector, STATUS } from '../connectors/weather.js';
import { registerTorrentRoutes } from './torrents.js';
import { registerCalendarRoutes } from './calendar.js';
import { loadSettings } from '../settings.js';

export async function registerWidgetRoutes(app, opts = {}) {
  // Settings are read once at boot and reread only on demand: the file is
  // edited by hand, so a read per request would be a syscall per dashboard
  // poll for a value that changes about twice a year.
  let settings = opts.settings ?? loadSettings({ logger: app.log });

  const weather =
    opts.weatherConnector ??
    createWeatherConnector({
      settings: () => settings,
      logger: app.log,
      ...opts.weatherOptions,
    });

  /**
   * GET /api/widgets/weather — current conditions plus a 4-day forecast.
   *
   * Every outcome is a 200 with a `status` the widget branches on, EXCEPT a
   * genuine upstream failure with no cached data to fall back on. That is the
   * notice/error distinction from docs/WIDGET-CONTRACT.md: "not configured"
   * and "stale" are things to render, not things that failed.
   */
  app.get('/api/widgets/weather', async (request, reply) => {
    const result = await weather.get({ force: request.query?.force === 'true' });

    if (result.status === STATUS.ERROR) {
      // 503, not 500: the weather service is unavailable, Haven is fine. The
      // shell's fetcher turns a throw into a soft notice when it holds cached
      // data of its own, so this still need not be a visible error.
      return reply.code(503).send(result);
    }

    if (result.status === STATUS.OK && !result.stale) {
      // Let the browser and any proxy in front honour the same 30-minute
      // window the server is already keeping, so a reload is free.
      reply.header('cache-control', `private, max-age=${Math.floor(result.expiresIn / 1000)}`);
    } else {
      // Stale or unconfigured: never cache, so recovery is immediate.
      reply.header('cache-control', 'no-store');
    }

    return result;
  });

  // Torrents lives in its own module: unlike weather it holds a login
  // session, so its retry and re-authentication logic is substantial enough
  // to be worth reading on its own. It registers GET /api/widgets/torrents.
  await registerTorrentRoutes(app, {
    connector: opts.torrentConnector,
    ...opts.torrentOptions,
  });

  // Calendar likewise: its connector holds ICS feed URLs, which are bearer
  // credentials, so the redaction rules are worth reading in one place.
  // It registers GET /api/widgets/calendar.
  await registerCalendarRoutes(app, {
    connector: opts.calendarConnector,
    ...opts.calendarOptions,
  });

  /** Re-reads `config/settings.json` — for a future settings screen. */
  app.decorate('reloadSettings', () => {
    settings = loadSettings({ logger: app.log });
    return settings;
  });
}
