/**
 * qBittorrent connector.
 *
 * qBittorrent's WebUI API is cookie-authenticated: you POST credentials to
 * `/api/v2/auth/login`, it hands back an `SID` cookie, and every subsequent
 * call carries it. That session requirement is one of the five reasons Haven
 * has a backend at all (docs/DESIGN.md) — the cookie and the credentials that
 * mint it live HERE, in this process, and never travel to the browser. The
 * shell only ever sees the normalised torrent list.
 *
 * Three behaviours this file exists to get right:
 *
 *   1. **The session is held, not re-established per request.** Logging in on
 *      every poll would be a login storm against the service every refreshMs.
 *   2. **An expired session self-heals.** qBittorrent answers 403 to a request
 *      with a dead SID. That is the 3am failure — the dashboard has been up for
 *      a week, the daemon restarted, and every tile goes red. So a 403 on a
 *      data call drops the cookie, logs in once, and retries once. Exactly
 *      once: a credential that has genuinely gone bad must not become an
 *      infinite retry loop.
 *   3. **Being down is not being broken.** A refused connection returns an
 *      `unreachable` result the route turns into a soft notice over the last
 *      good data. The host's scheduler owns the retry schedule and its
 *      backoff; this connector additionally refuses to re-attempt a *login*
 *      more often than the backoff allows, so a wrong password does not hammer
 *      the service once per tick.
 */

/** Outcome kinds. The route maps these onto HTTP; nothing else branches on them. */
export const RESULT = Object.freeze({
  OK: 'ok',
  NOT_CONFIGURED: 'not_configured',
  UNREACHABLE: 'unreachable',
  AUTH_FAILED: 'auth_failed',
});

/** Login backoff: base * 2^(n-1), capped. Mirrors the shell's scheduler. */
const LOGIN_BACKOFF_BASE_MS = 5_000;
const LOGIN_BACKOFF_MAX_MS = 5 * 60_000;

/** A slow or hanging qBittorrent must not hold a dashboard request open. */
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * qBittorrent's own state vocabulary, normalised to something a tile can show.
 * The upstream list is long and inconsistent (`pausedDL`, `stalledUP`,
 * `checkingResumeData`, ...); the widget should not have to know all of it.
 */
const STATE_MAP = new Map([
  ['downloading', 'downloading'],
  ['forcedDL', 'downloading'],
  ['metaDL', 'downloading'],
  ['allocating', 'downloading'],
  ['stalledDL', 'stalled'],
  ['uploading', 'seeding'],
  ['forcedUP', 'seeding'],
  ['stalledUP', 'seeding'],
  ['pausedDL', 'paused'],
  ['pausedUP', 'completed'],
  ['stoppedDL', 'paused'],
  ['stoppedUP', 'completed'],
  ['queuedDL', 'queued'],
  ['queuedUP', 'queued'],
  ['checkingDL', 'checking'],
  ['checkingUP', 'checking'],
  ['checkingResumeData', 'checking'],
  ['moving', 'moving'],
  ['error', 'error'],
  ['missingFiles', 'error'],
  ['unknown', 'unknown'],
]);

export function normaliseState(raw) {
  return STATE_MAP.get(raw) ?? 'unknown';
}

/**
 * Read connector settings from the environment.
 *
 * Absent settings are NOT an error: a Haven with no qBittorrent should render
 * a "not configured" tile with a hint, not a red one. `configured` is the flag
 * the route reads to decide which.
 */
export function readQbittorrentConfig(env = process.env) {
  const url = (env.HAVEN_QBITTORRENT_URL ?? '').trim();
  const username = (env.HAVEN_QBITTORRENT_USER ?? '').trim();
  const password = env.HAVEN_QBITTORRENT_PASS ?? '';

  return {
    url: url.replace(/\/+$/, ''),
    username,
    password,
    // A URL alone is enough: qBittorrent can be configured to bypass auth for
    // local subnets, in which case login is unnecessary and `/torrents/info`
    // answers directly.
    configured: url !== '',
  };
}

/**
 * `torrents/info` gives bytes and seconds; the widget wants neither raw nor
 * pre-formatted — it wants stable numbers it can format itself, and it wants
 * them under names that do not change when qBittorrent renames a field.
 *
 * `eta` of 8640000 is qBittorrent's "infinity" sentinel (100 days). It is
 * mapped to null so the widget shows a dash rather than "100d".
 */
const ETA_INFINITY = 8_640_000;

export function normaliseTorrent(raw) {
  const progress = Number(raw?.progress);
  const eta = Number(raw?.eta);

  return {
    // `hash` is qBittorrent's stable identity, and it is what the widget keys
    // its DOM nodes on — which is what makes diff-and-patch possible at all.
    hash: String(raw?.hash ?? ''),
    name: String(raw?.name ?? ''),
    // Clamped: a torrent mid-recheck can briefly report a progress above 1.
    progress: Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : 0,
    state: normaliseState(raw?.state),
    rawState: String(raw?.state ?? 'unknown'),
    dlspeed: toNumber(raw?.dlspeed),
    upspeed: toNumber(raw?.upspeed),
    size: toNumber(raw?.size),
    completed: toNumber(raw?.completed),
    eta: Number.isFinite(eta) && eta > 0 && eta < ETA_INFINITY ? eta : null,
    ratio: toNumber(raw?.ratio),
    category: raw?.category ? String(raw.category) : '',
    addedOn: toNumber(raw?.added_on),
  };
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Thrown internally to signal "the session is dead" — never escapes the module. */
class SessionExpiredError extends Error {
  constructor() {
    super('qBittorrent session expired');
    this.name = 'SessionExpiredError';
  }
}

/**
 * Build a connector.
 *
 * `fetchImpl` and `now` are injected so the whole thing can be driven against a
 * stubbed qBittorrent — including the expired-session path, which is the one
 * worth proving and the one you cannot exercise against a live service.
 */
export function createQbittorrentConnector({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = null,
} = {}) {
  const settings = readQbittorrentConfig(env);

  /** The session cookie. Held here, in the backend, and nowhere else. */
  let cookie = null;
  let loginFailures = 0;
  let retryLoginAfter = null;
  /** Concurrent callers share one login rather than racing several. */
  let loginInFlight = null;

  const api = (path) => `${settings.url}/api/v2${path}`;

  async function call(path, { method = 'GET', body = null, headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(api(path), {
        method,
        body,
        headers: {
          ...headers,
          ...(cookie ? { Cookie: cookie } : {}),
          // qBittorrent rejects cross-origin requests unless the Referer
          // matches its own address; sending our own base URL satisfies it.
          Referer: settings.url,
        },
        signal: controller.signal,
        // Cookies are handled explicitly above — never let an implementation
        // quietly persist them somewhere we do not control.
        redirect: 'manual',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Log in and capture the SID cookie.
   *
   * qBittorrent answers 200 with the body `Fails.` on bad credentials — a
   * 200 that means failure. Checking only the status code here is exactly how
   * you end up with a connector that silently never authenticates.
   */
  async function login() {
    const form = new URLSearchParams({
      username: settings.username,
      password: settings.password,
    });

    const response = await call('/auth/login', {
      method: 'POST',
      body: form.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (response.status === 403) {
      // Too many failed attempts — qBittorrent has banned this IP for a while.
      throw new AuthError('qBittorrent refused the login (the client may be temporarily banned).');
    }
    if (!response.ok) {
      throw new AuthError(`qBittorrent login failed with status ${response.status}.`);
    }

    const text = await response.text();
    if (typeof text === 'string' && text.trim() === 'Fails.') {
      throw new AuthError('qBittorrent rejected the username or password.');
    }

    const setCookie = readSetCookie(response.headers);
    const sid = setCookie && /(?:^|;\s*)SID=([^;]+)/.exec(setCookie)?.[1];
    if (!sid) {
      throw new AuthError('qBittorrent login returned no session cookie.');
    }

    cookie = `SID=${sid}`;
    loginFailures = 0;
    retryLoginAfter = null;
    logger?.info?.('qbittorrent: session established');
    return cookie;
  }

  /** One login at a time, and never inside a backoff window. */
  async function ensureSession() {
    if (cookie) return cookie;
    if (retryLoginAfter !== null && now() < retryLoginAfter) {
      throw new AuthError('qBittorrent login is backing off after a failed attempt.');
    }
    if (loginInFlight) return loginInFlight;

    loginInFlight = (async () => {
      try {
        return await login();
      } catch (error) {
        if (error instanceof AuthError) {
          // Only an auth failure earns a login backoff. A network failure is
          // the scheduler's problem and must not lock out a later retry that
          // would have succeeded.
          loginFailures += 1;
          retryLoginAfter = now() + loginBackoff(loginFailures);
        }
        throw error;
      } finally {
        loginInFlight = null;
      }
    })();

    return loginInFlight;
  }

  /**
   * Fetch the torrent list, re-authenticating once if the session has expired.
   *
   * The retry is deliberately bounded at one attempt. A 403 immediately after
   * a *fresh* login is not an expired session — it is a service that will
   * never accept us — and retrying that in a loop is how a connector turns a
   * misconfiguration into a denial of service against its own upstream.
   */
  async function fetchTorrents({ allowRetry = true } = {}) {
    if (settings.username !== '' || cookie) await ensureSession();

    const response = await call('/torrents/info');

    if (response.status === 403) {
      cookie = null;
      if (!allowRetry) throw new SessionExpiredError();
      // The session died under us — mint a new one and try exactly once more.
      logger?.warn?.('qbittorrent: session expired, re-authenticating');
      return fetchTorrents({ allowRetry: false });
    }

    if (!response.ok) {
      throw new Error(`qBittorrent returned status ${response.status}.`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error('qBittorrent returned an unexpected payload.');
    }
    return payload.map(normaliseTorrent);
  }

  return {
    get configured() {
      return settings.configured;
    },

    /** Test/telemetry seam. Reports WHETHER a session is held, never its value. */
    get hasSession() {
      return cookie !== null;
    },

    /** Drop the held session — used by tests and on an explicit reconnect. */
    reset() {
      cookie = null;
      loginFailures = 0;
      retryLoginAfter = null;
    },

    /**
     * The one method the route calls.
     *
     * Never throws for an operational condition: a down service, a bad
     * password and an absent configuration are all *results*, because each
     * needs a different tile and none of them should surface as a 500. A
     * genuinely unexpected error still throws and is handled upstream.
     */
    async getTorrents() {
      if (!settings.configured) {
        return {
          status: RESULT.NOT_CONFIGURED,
          message: 'qBittorrent is not configured.',
        };
      }

      try {
        const torrents = await fetchTorrents();
        return { status: RESULT.OK, torrents, fetchedAt: now() };
      } catch (error) {
        if (error instanceof AuthError) {
          return { status: RESULT.AUTH_FAILED, message: error.message };
        }
        if (error instanceof SessionExpiredError) {
          return {
            status: RESULT.AUTH_FAILED,
            message: 'qBittorrent rejected the session after re-authenticating.',
          };
        }
        // Everything else — refused connection, DNS failure, timeout, a
        // gateway's HTML error page — is "the service is not answering right
        // now", which is a soft condition and not a broken dashboard.
        logger?.warn?.({ err: error }, 'qbittorrent: unreachable');
        return {
          status: RESULT.UNREACHABLE,
          message: 'qBittorrent is not reachable right now.',
        };
      }
    },
  };
}

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

export function loginBackoff(failures) {
  const delay = LOGIN_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1);
  return Math.min(delay, LOGIN_BACKOFF_MAX_MS);
}

/**
 * `set-cookie` reading across the two shapes a fetch implementation offers:
 * undici's `getSetCookie()`, and a plain `get()` for anything simpler.
 */
function readSetCookie(headers) {
  if (!headers) return null;
  const all = headers.getSetCookie?.();
  if (Array.isArray(all) && all.length > 0) return all.join('; ');
  return headers.get?.('set-cookie') ?? null;
}
