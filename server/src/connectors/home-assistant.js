/**
 * The Home Assistant connector — the first source of notices.
 *
 * HA is reached with a LONG-LIVED ACCESS TOKEN, which is the strongest form of
 * "this must never reach the browser" in the whole project: the token is not
 * scoped, does not expire, and can unlock the front door. It lives in this
 * process, read from `HAVEN_HA_TOKEN`, and the browser only ever sees the
 * rendered notice. See docs/SECURITY.md.
 *
 * What it does: reads HA's `persistent_notification` entities and any entity
 * the user has explicitly listed, and maps each into the DESIGN §6.6 envelope.
 * It maps rather than passes through — an HA state object carries entity ids,
 * device ids and attribute bags that describe the home's internals, and none
 * of that needs to cross into a browser.
 *
 * Three behaviours it shares with the weather connector, for the same reasons:
 *
 *   1. NOT CONFIGURED IS NOT AN ERROR. No URL or no token yields a
 *      `not_configured` response the widget renders as a hint tile. A fresh
 *      clone should look unfinished, not broken.
 *   2. ONE FETCH SERVES EVERY BROWSER. The cache is here, not in each tab.
 *   3. AN UPSTREAM FAILURE IS A SOFT NOTICE. HA rebooting must not blank the
 *      tile when we already hold notices worth showing.
 */

import { SEVERITIES } from '../notices/envelope.js';

/** HA is on the LAN; it is either quick or it is down. */
export const HA_TIMEOUT_MS = 8000;

/** How long an HA read is reused. The route polls; HA does not need to. */
export const HA_CACHE_TTL_MS = 60 * 1000;

/** The source name stamped on every notice from here. */
export const HA_SOURCE = 'home-assistant';

export const HA_STATUS = Object.freeze({
  OK: 'ok',
  NOT_CONFIGURED: 'not_configured',
  ERROR: 'error',
});

const HINTS = Object.freeze({
  url: 'Set HAVEN_HA_URL in the environment to pull notices from Home Assistant.',
  token: 'Set HAVEN_HA_TOKEN (a long-lived access token) to pull notices from Home Assistant.',
});

/**
 * HA states that mean "nothing to say".
 *
 * An `unavailable` sensor is a broken integration, not a notice; surfacing it
 * would fill the tile with plumbing problems the moment anything flaps.
 */
const EMPTY_STATES = new Set(['unavailable', 'unknown', 'none', '', 'off']);

/**
 * Map an HA severity-ish attribute onto the envelope's three levels.
 *
 * HA has no single severity convention — notifications carry none at all,
 * alerts sometimes carry `severity`, and some templates use `critical`. Rather
 * than guessing per integration, anything unrecognised becomes `info`, which
 * is the level that cannot mislead.
 */
export function mapSeverity(value) {
  if (typeof value !== 'string') return 'info';
  const normalised = value.trim().toLowerCase();
  if (SEVERITIES.includes(normalised)) return normalised;
  if (['critical', 'error', 'alarm', 'emergency'].includes(normalised)) return 'urgent';
  if (['warning', 'caution'].includes(normalised)) return 'warn';
  return 'info';
}

/**
 * Turn one HA state object into an envelope, or `null` to skip it.
 *
 * Only these fields cross the boundary. The entity id is used as the notice's
 * external id — it is stable across HA restarts, which is what makes
 * re-ingest an update rather than a duplicate — but nothing else from the
 * attribute bag is copied.
 */
export function mapStateToNotice(state, { now = Date.now() } = {}) {
  if (!state || typeof state.entity_id !== 'string') return null;

  const attributes = state.attributes ?? {};
  const raw = typeof state.state === 'string' ? state.state.trim() : '';

  if (EMPTY_STATES.has(raw.toLowerCase())) return null;

  const title =
    firstString(attributes.title, attributes.friendly_name) ?? humanise(state.entity_id);

  // For a persistent notification the message is the body; for anything else
  // the state itself is the useful line ("3 packages waiting").
  const body = firstString(attributes.message, attributes.description) ?? raw;

  const due = firstIsoDate(attributes.due, attributes.due_date, attributes.start_time);

  return {
    id: state.entity_id,
    severity: mapSeverity(attributes.severity ?? attributes.level),
    title,
    body: body === title ? null : body,
    due,
    source: HA_SOURCE,
    // No URL: linking into HA would put the internal hostname in front-end
    // JSON. The action below is how the user acts on it instead.
    url: null,
    actions: dismissActionFor(state),
    receivedAt: now,
  };
}

/**
 * A persistent notification can be dismissed IN Home Assistant, which is worth
 * offering: dismissing it only on the dashboard leaves it nagging elsewhere.
 * The target is resolved server-side and never sent to the browser.
 */
function dismissActionFor(state) {
  if (!state.entity_id.startsWith('persistent_notification.')) return [];
  return [
    {
      id: 'ha-dismiss',
      label: 'Dismiss in Home Assistant',
      // Resolved against the configured base URL by the connector's `perform`.
      service: 'persistent_notification/dismiss',
      data: { notification_id: state.entity_id.split('.').slice(1).join('.') },
      dismisses: true,
    },
  ];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function firstIsoDate(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

/** `sensor.bin_collection_day` → `Bin collection day`. */
function humanise(entityId) {
  const name = entityId.split('.').slice(1).join('.').replace(/_/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

class HomeAssistantError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'HomeAssistantError';
    this.status = status ?? null;
  }
}

/**
 * Build the connector.
 *
 * Everything it depends on is injected, so the tests drive it against a
 * stubbed transport and a fake clock: no test needs a token, a Home Assistant
 * or the network.
 *
 * @param {object} [deps]
 * @param {() => string|null} [deps.baseUrl] read at call time
 * @param {() => string|null} [deps.token] read at call time
 * @param {() => string[]} [deps.entities] extra entity ids to include
 */
export function createHomeAssistantConnector({
  baseUrl = () => process.env.HAVEN_HA_URL || null,
  token = () => process.env.HAVEN_HA_TOKEN || null,
  entities = () => [],
  transport = globalThis.fetch,
  now = () => Date.now(),
  ttlMs = HA_CACHE_TTL_MS,
  timeoutMs = HA_TIMEOUT_MS,
  logger,
} = {}) {
  let cache = null;
  let inflight = null;

  const configuration = () => {
    const url = baseUrl();
    if (!url) return { ok: false, reason: 'missing_url', hint: HINTS.url };

    const key = token();
    if (!key) return { ok: false, reason: 'missing_token', hint: HINTS.token };

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, reason: 'invalid_url', hint: HINTS.url };
    }

    return { ok: true, base: parsed.toString().replace(/\/+$/, ''), key };
  };

  async function call(path, { base, key, method = 'GET', body } = {}) {
    const response = await transport(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      // The status is safe to surface; the URL is not, because it names an
      // internal host.
      throw new HomeAssistantError(`Home Assistant responded ${response.status}`, {
        status: response.status,
      });
    }

    return response.status === 204 ? null : response.json();
  }

  async function fetchNotices({ base, key }) {
    const states = (await call('/api/states', { base, key })) ?? [];
    if (!Array.isArray(states)) return [];

    const wanted = new Set(entities() ?? []);
    const at = now();

    return states
      .filter(
        (state) =>
          typeof state?.entity_id === 'string' &&
          (state.entity_id.startsWith('persistent_notification.') || wanted.has(state.entity_id))
      )
      .map((state) => mapStateToNotice(state, { now: at }))
      .filter(Boolean);
  }

  return {
    /** Whether the connector could run at all — used for the hint tile. */
    status() {
      const conf = configuration();
      return conf.ok
        ? { status: HA_STATUS.OK }
        : { status: HA_STATUS.NOT_CONFIGURED, reason: conf.reason, hint: conf.hint };
    },

    /**
     * Current notices from Home Assistant.
     *
     * Never throws for an expected condition: missing config and a failing HA
     * both produce something the caller can render.
     */
    async get({ force = false } = {}) {
      const conf = configuration();
      if (!conf.ok) {
        return { status: HA_STATUS.NOT_CONFIGURED, reason: conf.reason, hint: conf.hint };
      }

      const at = now();
      if (!force && cache && at - cache.at < ttlMs) {
        return { status: HA_STATUS.OK, notices: cache.value, cachedAt: cache.at, stale: false };
      }

      if (!inflight) {
        inflight = fetchNotices(conf).finally(() => {
          inflight = null;
        });
      }

      try {
        const value = await inflight;
        cache = { value, at: now() };
        return { status: HA_STATUS.OK, notices: value, cachedAt: cache.at, stale: false };
      } catch (error) {
        logger?.warn?.({ err: error }, 'home assistant unreachable');

        // Soft notice: last good read beats an error box, because HA
        // restarting is routine and the notices are still true.
        if (cache) {
          return {
            status: HA_STATUS.OK,
            notices: cache.value,
            cachedAt: cache.at,
            stale: true,
            notice: 'Showing the last reading — Home Assistant is unreachable.',
          };
        }

        return {
          status: HA_STATUS.ERROR,
          error: 'UPSTREAM_UNAVAILABLE',
          message:
            error instanceof HomeAssistantError ? error.message : 'Home Assistant is unreachable',
        };
      }
    },

    /**
     * Perform an action a notice declared.
     *
     * The browser sends an opaque action id; the route looks up what that id
     * means and passes the stored definition here. This is the only place a
     * Home Assistant service is called, and the token never leaves it.
     */
    async perform(action) {
      const conf = configuration();
      if (!conf.ok) {
        return { status: HA_STATUS.NOT_CONFIGURED, reason: conf.reason, hint: conf.hint };
      }

      if (!action?.service || !/^[a-z_]+\/[a-z_]+$/.test(action.service)) {
        // Only a `domain/service` pair, never a free path: a stored action is
        // still data that arrived from outside, so it does not get to choose
        // an arbitrary URL on the Home Assistant host.
        return { status: HA_STATUS.ERROR, error: 'UNSUPPORTED_ACTION' };
      }

      try {
        await call(`/api/services/${action.service}`, {
          ...conf,
          method: 'POST',
          body: action.data ?? {},
        });
        // The next read must reflect what we just did.
        cache = null;
        return { status: HA_STATUS.OK };
      } catch (error) {
        logger?.warn?.({ err: error }, 'home assistant action failed');
        return {
          status: HA_STATUS.ERROR,
          error: 'UPSTREAM_UNAVAILABLE',
          message: error instanceof HomeAssistantError ? error.message : 'Action failed',
        };
      }
    },

    clearCache() {
      cache = null;
    },
  };
}
