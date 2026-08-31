/**
 * Torrents widget API — `GET /api/widgets/torrents`.
 *
 * The route is thin on purpose: the connector decides what happened, this
 * decides what the browser is told. The one piece of judgement here is the
 * **last-good cache**, and it is the reason the endpoint answers 200 far more
 * often than the upstream service is actually up.
 *
 * The rule from docs/WIDGET-CONTRACT.md: *a soft notice is not a hard error*.
 * A dashboard that flashes a red tile every time qBittorrent restarts is worse
 * than one that shows five-minute-old data with a marker on it, so:
 *
 *   service up          -> 200, fresh list, no notice
 *   service down + cache -> 200, the last good list + a `stale` notice
 *   service down, no cache -> 200, `unreachable: true` and an empty list
 *   not configured       -> 200, `configured: false` and a hint
 *
 * Note what is NOT in any of those: a 5xx. A transient upstream failure is not
 * a server error, and returning one would make the shell's error boundary draw
 * an error card for something that will fix itself in thirty seconds.
 */

import { createQbittorrentConnector, RESULT } from '../connectors/qbittorrent.js';

/**
 * How long a cached list stays servable after the service goes away.
 *
 * Not forever: torrent progress that is an hour stale is actively misleading,
 * and at that point "unreachable" is the more honest tile. Ten minutes is
 * comfortably longer than a service restart and shorter than a user would
 * believe the numbers for.
 */
export const STALE_MAX_AGE_MS = 10 * 60_000;

export async function registerTorrentRoutes(app, { connector, now = () => Date.now() } = {}) {
  const qbt = connector ?? createQbittorrentConnector({ logger: app.log });

  /** The last successful list, kept so a blip does not blank the tile. */
  let lastGood = null;

  app.get('/api/widgets/torrents', async () => {
    const result = await qbt.getTorrents();

    if (result.status === RESULT.NOT_CONFIGURED) {
      return {
        configured: false,
        torrents: [],
        notices: [
          {
            message: 'qBittorrent is not configured.',
            // The hint names the variables rather than describing them, so the
            // tile tells you exactly what to set without a trip to the docs.
            hint: 'Set HAVEN_QBITTORRENT_URL, _USER and _PASS, then restart Haven.',
          },
        ],
      };
    }

    if (result.status === RESULT.OK) {
      lastGood = { torrents: result.torrents, at: now() };
      return {
        configured: true,
        torrents: result.torrents,
        fetchedAt: lastGood.at,
        notices: [],
      };
    }

    // Everything below is a failure the user should not lose their data over.
    const age = lastGood ? now() - lastGood.at : Infinity;
    if (lastGood && age < STALE_MAX_AGE_MS) {
      return {
        configured: true,
        torrents: lastGood.torrents,
        fetchedAt: lastGood.at,
        stale: true,
        notices: [{ message: result.message, stale: true }],
      };
    }

    // No usable cache: say plainly that the service is unreachable. This is
    // still a 200 — it is a *state of the world*, not a failure of Haven, and
    // the widget renders it as a clear tile rather than an error card.
    return {
      configured: true,
      torrents: [],
      unreachable: true,
      // An auth failure is separated out because the fix is different: one
      // needs the service started, the other needs the password corrected.
      authFailed: result.status === RESULT.AUTH_FAILED,
      notices: [{ message: result.message }],
    };
  });

  return qbt;
}
