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
 *   auth wanted, none set -> 200, `authRequired: true` and a hint naming the vars
 *
 * Note what is NOT in any of those: a 5xx. A transient upstream failure is not
 * a server error, and returning one would make the shell's error boundary draw
 * an error card for something that will fix itself in thirty seconds.
 *
 * ── Per-widget configuration ──────────────────────────────────────────────
 * `?instance=<widget id>` selects ONE widget instance's configuration, so two
 * torrents widgets can point at two different qBittorrent instances with
 * different credentials. The id names a row; the browser sends nothing else,
 * and gets nothing else back. The URL and the API key are read HERE, from the
 * instance store and the encrypted credential store, and never travel.
 *
 * Without the parameter — or for an instance that configures no URL of its own
 * — the environment answers, exactly as it did before this existed. See
 * `resolveQbittorrentSettings` for the precedence rule and why it is whole-
 * instance rather than field-by-field.
 * ─────────────────────────────────────────────────────────────────────────
 */

import {
  createQbittorrentConnector,
  resolveQbittorrentSettings,
  RESULT,
} from '../connectors/qbittorrent.js';
import { createInstanceStore } from '../db/instances-store.js';

/**
 * How long a cached list stays servable after the service goes away.
 *
 * Not forever: torrent progress that is an hour stale is actively misleading,
 * and at that point "unreachable" is the more honest tile. Ten minutes is
 * comfortably longer than a service restart and shorter than a user would
 * believe the numbers for.
 */
export const STALE_MAX_AGE_MS = 10 * 60_000;

/** The config field holding this instance's API key. */
export const SECRET_FIELD = 'apiKey';

/**
 * The env-backed connector, under a key no instance id can collide with.
 *
 * `/` cannot appear in the cache key built from an instance id below, because
 * that key is always `instance:<id>` — so this constant is unreachable by any
 * widget, however it is named.
 */
const ENV_CONNECTOR_KEY = 'env';

export async function registerTorrentRoutes(
  app,
  { connector, db, credentials, fetchImpl, env, now = () => Date.now() } = {}
) {
  const database = db ?? app.db ?? null;

  // The roster is only needed to look a widget's own config up. Without a
  // database (a bare Fastify instance in a unit test) the route still works —
  // it just has nothing but the environment to answer from.
  const instances = database ? createInstanceStore(database, { credentials }) : null;

  /**
   * Connectors, keyed by configuration rather than built per request.
   *
   * A connector holds a login session and a login backoff, so rebuilding one
   * every five seconds would re-authenticate on every poll and throw away the
   * backoff that stops a wrong password hammering the service. Keyed by a
   * fingerprint of the resolved settings, so a config change in the UI builds
   * a new one and the old session is dropped with it.
   */
  const connectors = new Map();

  /**
   * The last successful list, PER INSTANCE.
   *
   * One shared variable would serve one widget's torrents to another the
   * moment two instances point at different services — the cache is keyed by
   * the thing it is a cache *of*.
   */
  const lastGood = new Map();

  /** Distinct settings must produce distinct connectors — and never log the key. */
  const fingerprint = (settings) =>
    JSON.stringify([settings.url, settings.username, settings.apiKey !== '', settings.configured]);

  function connectorFor(cacheKey, settings) {
    const print = fingerprint(settings);
    const existing = connectors.get(cacheKey);
    if (existing && existing.print === print) return existing.qbt;

    // `fetchImpl` is injected one layer further out than a stubbed connector,
    // deliberately: a test that stubs the connector never exercises the
    // config-to-connector wiring, which is where this feature actually lives.
    // The same reasoning as `weather-settings-wiring.test.js`.
    const qbt = createQbittorrentConnector({
      settings,
      logger: app.log,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    connectors.set(cacheKey, { print, qbt });
    return qbt;
  }

  /**
   * Which connector answers for this request.
   *
   * An injected `connector` always wins, so every existing test that hands one
   * in keeps driving the route exactly as before.
   */
  function resolve(instanceId) {
    if (connector) return { qbt: connector, cacheKey: ENV_CONNECTOR_KEY };

    if (instanceId && instances) {
      const instance = instances.get(instanceId);
      if (instance) {
        // The plaintext key, read from the encrypted store. This is the only
        // legitimate reader of it (see `instances-store.readSecret`), and the
        // value is passed to the connector and never anywhere else.
        const secret = instances.readSecret(instanceId, SECRET_FIELD);
        const settings = resolveQbittorrentSettings(instance.config, secret, env ?? process.env);
        return { qbt: connectorFor(`instance:${instanceId}`, settings), cacheKey: instanceId };
      }
    }

    return {
      qbt: connectorFor(
        ENV_CONNECTOR_KEY,
        resolveQbittorrentSettings({}, null, env ?? process.env)
      ),
      cacheKey: ENV_CONNECTOR_KEY,
    };
  }

  app.get('/api/widgets/torrents', async (request) => {
    const instanceId = typeof request.query?.instance === 'string' ? request.query.instance : null;
    const { qbt, cacheKey } = resolve(instanceId);

    const result = await qbt.getTorrents();

    if (result.status === RESULT.NOT_CONFIGURED) {
      return {
        configured: false,
        torrents: [],
        notices: [
          {
            message: 'qBittorrent is not configured.',
            // The hint names both routes now that there are two: this widget's
            // own settings, and the environment that still backs every widget
            // which does not configure itself.
            hint: 'Set the server address and API key in this widget’s settings, or set HAVEN_QBITTORRENT_URL plus either _API_KEY or _USER and _PASS and restart Haven.',
          },
        ],
      };
    }

    if (result.status === RESULT.OK) {
      const fresh = { torrents: result.torrents, at: now() };
      lastGood.set(cacheKey, fresh);
      return {
        configured: true,
        torrents: result.torrents,
        fetchedAt: fresh.at,
        notices: [],
      };
    }

    // Everything below is a failure the user should not lose their data over.
    const cached = lastGood.get(cacheKey) ?? null;
    const age = cached ? now() - cached.at : Infinity;
    if (cached && age < STALE_MAX_AGE_MS) {
      return {
        configured: true,
        torrents: cached.torrents,
        fetchedAt: cached.at,
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
      // And "we were never given credentials" is separated from both, because
      // its fix is to *supply* a credential rather than to correct one. The
      // hint travels with it so the tile can name the variables to set.
      authRequired: result.status === RESULT.AUTH_REQUIRED,
      notices: [{ message: result.message, ...(result.hint ? { hint: result.hint } : {}) }],
    };
  });

  return connector ?? null;
}
