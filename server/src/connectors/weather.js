/**
 * The OpenWeatherMap connector.
 *
 * This connector is the reason Haven has a backend at all. The dashboard it
 * replaces put its API key in plaintext in a committed `config.json`, which
 * means the key is in git history and readable by anyone the moment the repo
 * is public. Here the key comes from the environment, stays in this process,
 * and the browser only ever sees the rendered weather. See docs/SECURITY.md.
 *
 * Three behaviours the widget depends on, all decided here rather than in the
 * front end:
 *
 *   1. NO KEY IS NOT AN ERROR. An unconfigured install gets a `not_configured`
 *      response the widget renders as a tile with a hint. A fresh clone should
 *      look unfinished, not broken.
 *   2. ONE CACHE FOR EVERY BROWSER. The old widget cached in `localStorage`,
 *      so each tab and each device burned its own share of a rate-limited free
 *      tier. The cache lives here instead: five tabs and a phone share one
 *      upstream call every 30 minutes.
 *   3. AN UPSTREAM FAILURE IS A SOFT NOTICE, NOT A HARD ERROR. If we hold a
 *      previous good response we serve it with a staleness marker; the widget
 *      draws the data with a marker instead of an error box. Only a failure
 *      with nothing cached is a real error.
 */

const OWM_BASE = 'https://api.openweathermap.org/data/2.5';

/** Matches the old widget's 30 minutes, and is well inside the free tier. */
export const CACHE_TTL_MS = 30 * 60 * 1000;

/** How long a stale entry may still be served when upstream is failing. */
export const STALE_MAX_MS = 24 * 60 * 60 * 1000;

/** Upstream is not allowed to hang a dashboard request indefinitely. */
export const UPSTREAM_TIMEOUT_MS = 10_000;

export const STATUS = Object.freeze({
  OK: 'ok',
  NOT_CONFIGURED: 'not_configured',
  ERROR: 'error',
});

/**
 * Why the connector cannot produce data, in the words the widget shows.
 *
 * These are hints, not errors: each one names the single thing to do next.
 * The key itself is never echoed, not even partially.
 */
const HINTS = Object.freeze({
  key: 'Set HAVEN_OPENWEATHER_API_KEY in the environment to enable weather.',
  location: 'Set weather.latitude and weather.longitude in config/settings.json to enable weather.',
});

/**
 * Collapse OpenWeatherMap's 3-hourly forecast list into daily summaries.
 *
 * Ported from the old widget, with its two rules kept: today is skipped (the
 * current conditions already cover it) and a day's icon is the most frequent
 * one across its slots rather than whichever happened to be first — a day
 * that is cloudy from 03:00 and sunny from 09:00 should not read as cloudy.
 */
export function summariseForecast(list = [], { now = Date.now() } = {}) {
  const days = new Map();

  for (const item of list) {
    if (!item?.dt || !item.main || !Array.isArray(item.weather)) continue;

    const date = new Date(item.dt * 1000);
    const key = date.toISOString().slice(0, 10);

    if (!days.has(key)) days.set(key, { temps: [], icons: [], descriptions: [] });
    const day = days.get(key);

    if (typeof item.main.temp === 'number') day.temps.push(item.main.temp);
    if (item.weather[0]?.icon) day.icons.push(item.weather[0].icon);
    if (item.weather[0]?.description) day.descriptions.push(item.weather[0].description);
  }

  const today = new Date(now).toISOString().slice(0, 10);

  return [...days.entries()]
    .filter(([date, day]) => date !== today && day.temps.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 4)
    .map(([date, day]) => ({
      date,
      // The client formats the weekday; the server must not guess a locale.
      min: Math.round(Math.min(...day.temps)),
      max: Math.round(Math.max(...day.temps)),
      temp: Math.round(day.temps.reduce((a, b) => a + b, 0) / day.temps.length),
      icon: mostFrequent(day.icons),
      description: mostFrequent(day.descriptions),
    }));
}

function mostFrequent(values) {
  if (values.length === 0) return null;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Shape the upstream payloads into what the widget renders.
 *
 * Only the fields the widget uses cross this boundary. That is deliberate:
 * the upstream response carries station ids and precise coordinates, and none
 * of that needs to reach a browser.
 */
export function shapeWeather(current, forecast, { units, locationName, now = Date.now() } = {}) {
  return {
    units,
    // The configured name wins: it is what the user calls where they live.
    location: locationName ?? current?.name ?? null,
    current: {
      temp: Math.round(current?.main?.temp ?? 0),
      feelsLike: Math.round(current?.main?.feels_like ?? current?.main?.temp ?? 0),
      humidity: current?.main?.humidity ?? null,
      windSpeed: current?.wind?.speed ?? null,
      description: current?.weather?.[0]?.description ?? null,
      icon: current?.weather?.[0]?.icon ?? null,
      /** OWM condition group id — the stable thing to branch tone on. */
      conditionId: current?.weather?.[0]?.id ?? null,
      sunrise: current?.sys?.sunrise ?? null,
      sunset: current?.sys?.sunset ?? null,
    },
    forecast: summariseForecast(forecast?.list ?? [], { now }),
    fetchedAt: now,
  };
}

class UpstreamError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status ?? null;
  }
}

/**
 * Build the connector.
 *
 * Everything the connector depends on is injected, so the tests drive it
 * against a stubbed transport and a fake clock and never touch the network or
 * need a real API key.
 *
 * @param {object} [deps]
 * @param {() => string|null} [deps.apiKey] reads the key at call time, so a
 *   test can change it without rebuilding the connector
 * @param {() => object} [deps.settings] current `weather` settings
 * @param {typeof fetch} [deps.transport]
 * @param {() => number} [deps.now]
 */
export function createWeatherConnector({
  apiKey = () => process.env.HAVEN_OPENWEATHER_API_KEY || null,
  settings = () => ({}),
  transport = globalThis.fetch,
  now = () => Date.now(),
  ttlMs = CACHE_TTL_MS,
  staleMaxMs = STALE_MAX_MS,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
  logger,
} = {}) {
  /** The single shared cache entry: `{ value, at }`. */
  let cache = null;
  /** In-flight request, so concurrent callers make ONE upstream call. */
  let inflight = null;

  async function getJson(url) {
    // AbortSignal.timeout rather than a bare fetch: without it a hung upstream
    // holds a dashboard request open until the client gives up.
    const response = await transport(url, { signal: AbortSignal.timeout(timeoutMs) });

    if (!response.ok) {
      // The message is safe to surface: it names the status, never the URL,
      // because the URL carries the API key as a query parameter.
      throw new UpstreamError(`OpenWeatherMap responded ${response.status}`, {
        status: response.status,
      });
    }

    return response.json();
  }

  async function fetchUpstream({ key, latitude, longitude, units, locationName }) {
    const params = new URLSearchParams({
      lat: String(latitude),
      lon: String(longitude),
      units,
      appid: key,
    });

    // Both calls go out together — they are independent and the pair is
    // behind one 30-minute cache anyway.
    const [current, forecast] = await Promise.all([
      getJson(`${OWM_BASE}/weather?${params}`),
      getJson(`${OWM_BASE}/forecast?${params}`),
    ]);

    return shapeWeather(current, forecast, { units, locationName, now: now() });
  }

  return {
    /**
     * The response the route returns.
     *
     * Never throws for an expected condition. Missing key, missing location
     * and a failing upstream all produce a response the widget can render.
     */
    async get({ force = false } = {}) {
      const key = apiKey();
      const { units = 'metric', locationName = null, latitude, longitude } = settings() ?? {};

      // A "not configured" state is a normal state for a fresh install, so it
      // is reported as such rather than as a 500 the user has to interpret.
      if (!key) {
        return { status: STATUS.NOT_CONFIGURED, reason: 'missing_api_key', hint: HINTS.key };
      }
      if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        return { status: STATUS.NOT_CONFIGURED, reason: 'missing_location', hint: HINTS.location };
      }

      const at = now();

      if (!force && cache && at - cache.at < ttlMs) {
        return {
          status: STATUS.OK,
          data: cache.value,
          cachedAt: cache.at,
          stale: false,
          // Lets the route set a matching max-age.
          expiresIn: Math.max(0, ttlMs - (at - cache.at)),
        };
      }

      // Join an in-flight refresh instead of starting a second upstream call.
      if (!inflight) {
        inflight = fetchUpstream({ key, latitude, longitude, units, locationName }).finally(() => {
          inflight = null;
        });
      }

      try {
        const value = await inflight;
        cache = { value, at: now() };
        return {
          status: STATUS.OK,
          data: value,
          cachedAt: cache.at,
          stale: false,
          expiresIn: ttlMs,
        };
      } catch (error) {
        logger?.warn?.({ err: error }, 'weather upstream failed');

        // The soft-notice path: last good data plus a staleness marker beats
        // an error box. Past `staleMaxMs` the data is too old to be worth
        // showing and this becomes a real error.
        if (cache && now() - cache.at < staleMaxMs) {
          return {
            status: STATUS.OK,
            data: cache.value,
            cachedAt: cache.at,
            stale: true,
            notice: 'Showing the last good reading — the weather service is unreachable.',
          };
        }

        return {
          status: STATUS.ERROR,
          error: 'UPSTREAM_UNAVAILABLE',
          message: error instanceof UpstreamError ? error.message : 'Weather service unreachable',
        };
      }
    },

    /** Test seam, and what a future manual "refresh now" would call. */
    clearCache() {
      cache = null;
    },

    peek() {
      return cache;
    },
  };
}
