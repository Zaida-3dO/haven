/**
 * A stubbed qBittorrent WebUI API.
 *
 * Every connector test runs against this and never against a live service —
 * partly because a test that needs a running daemon is a test that gets
 * deleted, and mostly because the interesting path (a session that expires
 * mid-life) cannot be provoked on demand against a real one.
 *
 * It models the three things about qBittorrent that actually shape the
 * connector:
 *
 *   1. Login is a form POST that answers 200 with the body `Fails.` on bad
 *      credentials — a success status that means failure.
 *   2. A valid login returns an `SID` cookie in `set-cookie`.
 *   3. A data call with a missing or stale SID answers **403**, not 401.
 *
 * Hostnames are `.invalid` throughout; nothing here points at a real address.
 */

export const FAKE_URL = 'http://qbittorrent.invalid:8080';

export function createFakeQbittorrent({
  username = 'haven',
  password = 'correct-horse',
  torrents = [],
} = {}) {
  const state = {
    /** Sessions the stub currently considers valid. */
    validSids: new Set(),
    nextSid: 1,
    /** Set to fail the next N data calls with 403 — an expired session. */
    expireNextInfoCall: false,
    /** Set to make the transport throw, as a refused connection does. */
    offline: false,
    torrents,
    calls: { login: 0, info: 0 },
  };

  function response(status, body, headers = {}) {
    const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name) => map.get(name.toLowerCase()) ?? null },
      async text() {
        return typeof body === 'string' ? body : JSON.stringify(body);
      },
      async json() {
        return typeof body === 'string' ? JSON.parse(body) : body;
      },
    };
  }

  /** A `fetch`-shaped function to hand the connector. */
  async function fetchImpl(url, options = {}) {
    if (state.offline) {
      throw new TypeError('fetch failed');
    }

    const path = String(url).replace(FAKE_URL, '');

    if (path === '/api/v2/auth/login') {
      state.calls.login += 1;
      const form = new URLSearchParams(options.body ?? '');
      if (form.get('username') !== username || form.get('password') !== password) {
        // The trap: 200 OK, and the body is the only thing that says no.
        return response(200, 'Fails.');
      }
      const sid = `sid-${state.nextSid++}`;
      state.validSids.add(sid);
      return response(200, 'Ok.', { 'set-cookie': `SID=${sid}; HttpOnly; path=/` });
    }

    if (path === '/api/v2/torrents/info') {
      state.calls.info += 1;
      const sid = /SID=([^;]+)/.exec(options.headers?.Cookie ?? '')?.[1];

      if (state.expireNextInfoCall) {
        // One expiry, then the (newly minted) session works again — exactly
        // what a qBittorrent restart looks like to a long-lived dashboard.
        state.expireNextInfoCall = false;
        if (sid) state.validSids.delete(sid);
        return response(403, 'Forbidden');
      }

      if (!sid || !state.validSids.has(sid)) {
        return response(403, 'Forbidden');
      }
      return response(200, state.torrents);
    }

    return response(404, 'Not Found');
  }

  return {
    fetchImpl,
    state,
    /** The next `torrents/info` call behaves as though the session died. */
    expireSession() {
      state.expireNextInfoCall = true;
    },
    /** Invalidate every session without warning the client. */
    dropAllSessions() {
      state.validSids.clear();
    },
    setOffline(value = true) {
      state.offline = value;
    },
    setTorrents(next) {
      state.torrents = next;
    },
    env(overrides = {}) {
      return {
        HAVEN_QBITTORRENT_URL: FAKE_URL,
        HAVEN_QBITTORRENT_USER: username,
        HAVEN_QBITTORRENT_PASS: password,
        ...overrides,
      };
    },
  };
}

/** One realistic torrent, in qBittorrent's own field names. */
export function rawTorrent(overrides = {}) {
  return {
    hash: 'aaaa1111',
    name: 'ubuntu-24.04-desktop-amd64.iso',
    progress: 0.42,
    state: 'downloading',
    dlspeed: 1_500_000,
    upspeed: 250_000,
    size: 6_000_000_000,
    completed: 2_520_000_000,
    eta: 2_400,
    ratio: 0.35,
    category: 'linux',
    added_on: 1_700_000_000,
    ...overrides,
  };
}
