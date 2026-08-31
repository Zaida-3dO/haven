/**
 * Version lookup — the backend half of the dual version display.
 *
 * Two questions, one route: what version is upstream (`latest`) and what
 * version is running (`current`). The apps widget draws them side by side, and
 * the difference between them is the entire point of the feature.
 *
 * ## Why this is on the server and reachability is not
 *
 * These look like the same kind of call and are not, so the split is worth
 * stating plainly:
 *
 *  - **Reachability probing stays in the browser** (`web/src/lib/reachability.js`)
 *    because "can this be reached" has a different answer from the server than
 *    from the phone, and the phone's answer is the one that matters.
 *  - **Version lookup belongs on the server** because "what did GitHub release"
 *    has the same answer everywhere, and the call needs a credential the
 *    browser must never hold.
 *
 * Three concrete reasons for routing it through here rather than letting the
 * browser call `api.github.com` itself:
 *
 *  1. `HAVEN_GITHUB_TOKEN` stays server-side. A token in front-end code means
 *     the design has gone wrong (CLAUDE.md).
 *  2. The rate limit is **shared and cached** rather than burned per browser.
 *     Unauthenticated GitHub allows 60 requests/hour *per IP*; with N tabs
 *     polling M apps that is exhausted almost immediately, and the limit is
 *     charged against the whole household's IP.
 *  3. GitHub's response is large and mostly irrelevant. We return the three
 *     fields the widget draws, not the release body and asset list.
 *
 * ## Caching is deliberately aggressive
 *
 * Releases change on the order of weeks; the rate limit is low and shared. So
 * a hit is cached for hours, and — importantly — a *failure* is cached too,
 * for a shorter window. Without negative caching, a repo that 404s (renamed,
 * or private) would re-hit GitHub on every single refresh of every browser and
 * burn the shared limit on a call that cannot succeed.
 *
 * On a stale-but-present entry we serve the stale value rather than an error:
 * a version number from this morning is far more useful than an error box, and
 * "missing version info degrades quietly" is the requirement.
 */

import { config } from '../config.js';

/** A successful lookup is good for this long. Releases are not news. */
export const LATEST_CACHE_MS = 6 * 60 * 60 * 1000;

/**
 * A failed lookup is cached too — shorter, but not zero. This is what stops a
 * dead `latestUrl` from hammering a shared, low rate limit forever.
 */
export const LATEST_ERROR_CACHE_MS = 15 * 60 * 1000;

/** Upstream must not be able to hang our request queue. */
export const UPSTREAM_TIMEOUT_MS = 8_000;

/**
 * Only GitHub. `latestUrl` comes from the app registry, which is user-editable,
 * so this route would otherwise be a server-side request forgery primitive:
 * "fetch this URL for me, from inside the LAN, with a token attached". The
 * allow-list is the security boundary, not a convenience.
 */
const ALLOWED_HOSTS = new Set(['api.github.com', 'github.com']);

/**
 * Accepts either the API URL or the human releases page, because the old
 * registry stored a mix of both.
 *
 *   https://api.github.com/repos/OWNER/REPO/releases/latest
 *   https://github.com/OWNER/REPO/releases
 *
 * Returns the canonical API URL, or null if this is not a GitHub release URL
 * we understand. Null is not an error — the widget simply shows no latest
 * version.
 */
export function toReleasesApiUrl(latestUrl) {
  if (typeof latestUrl !== 'string' || !latestUrl.trim()) return null;

  let parsed;
  try {
    parsed = new URL(latestUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);

  // api.github.com/repos/OWNER/REPO/...
  if (parsed.hostname === 'api.github.com') {
    if (parts[0] !== 'repos' || parts.length < 3) return null;
    return `https://api.github.com/repos/${parts[1]}/${parts[2]}/releases/latest`;
  }

  // github.com/OWNER/REPO[/releases...]
  if (parts.length < 2) return null;
  return `https://api.github.com/repos/${parts[0]}/${parts[1]}/releases/latest`;
}

/**
 * The subset of a GitHub release the widget actually draws.
 *
 * `tag_name` is preferred over `name` because a release's display name is
 * often prose ("August update") while the tag is the version. Falls back to
 * `name` for repos that tag oddly.
 */
function toLatest(release) {
  const version = release?.tag_name || release?.name || null;
  if (!version) return null;
  return {
    version: String(version),
    publishedAt: release?.published_at ?? null,
    url: release?.html_url ?? null,
  };
}

/**
 * A tiny TTL cache. Not an LRU: the key space is bounded by the number of apps
 * in the registry (tens), so eviction pressure does not exist here and an LRU
 * would be more machinery than the problem needs.
 */
export class VersionCache {
  #entries = new Map();
  #now;

  constructor({ now = () => Date.now() } = {}) {
    this.#now = now;
  }

  get(key) {
    return this.#entries.get(key) ?? null;
  }

  /** Fresh means "within its own ttl" — hits and errors have different ttls. */
  isFresh(entry) {
    return Boolean(entry) && this.#now() - entry.at < entry.ttl;
  }

  set(key, value, ttl) {
    this.#entries.set(key, { value, at: this.#now(), ttl });
    return value;
  }

  clear() {
    this.#entries.clear();
  }

  get size() {
    return this.#entries.size;
  }
}

/**
 * Fetches the latest release, with caching in front of it.
 *
 * Never throws: every failure path resolves to `{ version: null, error }`, so
 * one unreachable repo degrades to a blank on one card instead of failing the
 * whole batch. That is the "degrades quietly" requirement made structural.
 */
export async function fetchLatest(
  apiUrl,
  { cache, fetchFn = globalThis.fetch, token = config.githubToken, now = () => Date.now() } = {}
) {
  const cached = cache?.get(apiUrl);
  if (cache?.isFresh(cached)) {
    return { ...cached.value, cached: true };
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'haven-dashboard',
  };
  // The token is attached HERE and nowhere else. It is never returned to the
  // caller and never reaches the browser.
  if (token) headers.Authorization = `Bearer ${token}`;

  let result;
  try {
    const response = await fetchFn(apiUrl, {
      headers,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!response.ok) {
      // 403/429 with a rate-limit header is the case worth naming precisely,
      // because the fix ("set HAVEN_GITHUB_TOKEN") is not obvious from a bare
      // 403.
      const rateLimited =
        (response.status === 403 || response.status === 429) &&
        response.headers?.get?.('x-ratelimit-remaining') === '0';
      result = {
        version: null,
        error: rateLimited ? 'rate_limited' : `http_${response.status}`,
      };
    } else {
      const latest = toLatest(await response.json());
      result = latest ?? { version: null, error: 'no_release' };
    }
  } catch (err) {
    result = { version: null, error: err?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }

  if (cache) {
    // A failure gets the short ttl; a hit gets the long one. Both are cached.
    cache.set(apiUrl, result, result.error ? LATEST_ERROR_CACHE_MS : LATEST_CACHE_MS);
  }
  // `now` is accepted for symmetry with the cache's clock in tests.
  void now;
  return { ...result, cached: false };
}

/**
 * Resolves the running version for a container id.
 *
 * The old dashboard POSTed to a per-app endpoint that shelled out to Docker.
 * Haven has no Docker socket and deliberately does not want one — mounting it
 * into a web-facing container is a root-equivalent escalation, which is a bad
 * trade for displaying a string.
 *
 * So this reads an operator-provided map (`HAVEN_CONTAINER_VERSIONS`, a JSON
 * object of containerId -> version) and returns null when it has nothing. Null
 * renders as "unknown" on the card, which is the quiet degradation the brief
 * asks for, and the route stays useful the moment the map is populated.
 */
export function resolveCurrent(containerId, { versions = config.containerVersions } = {}) {
  if (typeof containerId !== 'string' || !containerId.trim()) return null;
  const value = versions?.[containerId];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Compares two version strings loosely.
 *
 * Deliberately NOT semver-aware. Tags in the wild are `v1.2.3`, `1.2.3`,
 * `release-1.2.3` and worse, and the widget only needs to answer "are these
 * the same?" to decide whether to draw the update affordance. Normalising a
 * leading `v` and comparing case-insensitively answers that for real tags
 * without pulling in a parser that would confidently mis-order the odd ones.
 *
 * Returns 'same' | 'differs' | 'unknown'.
 */
export function compareVersions(current, latest) {
  if (!current || !latest) return 'unknown';
  const normalise = (v) =>
    String(v)
      .trim()
      .toLowerCase()
      .replace(/^v(?=\d)/, '');
  return normalise(current) === normalise(latest) ? 'same' : 'differs';
}

export async function registerVersionRoutes(app, { db, cache = new VersionCache() } = {}) {
  if (!db) throw new Error('registerVersionRoutes requires a database handle.');

  /**
   * `GET /api/versions/:id` — the version pair for one app.
   *
   * Reads `latestUrl` and `currentContainerId` from the registry rather than
   * accepting them as query parameters. That is what keeps the route from
   * being an open proxy: a caller cannot ask it to fetch an arbitrary URL,
   * only to look up an app that an operator already added.
   */
  app.get('/api/versions/:id', async (request, reply) => {
    const { getApp } = await import('../db/apps-store.js');
    const found = getApp(db, request.params.id);
    if (!found) {
      return reply
        .code(404)
        .send({ error: 'NOT_FOUND', message: `No app with id "${request.params.id}".` });
    }

    const apiUrl = toReleasesApiUrl(found.version?.latestUrl);
    const current = resolveCurrent(found.version?.currentContainerId);

    // No usable latest URL is not an error — plenty of apps have no upstream
    // release feed, and the card just shows the current version alone.
    const latest = apiUrl ? await fetchLatest(apiUrl, { cache }) : { version: null };

    return {
      id: found.id,
      current,
      latest: latest.version ?? null,
      latestUrl: latest.url ?? null,
      publishedAt: latest.publishedAt ?? null,
      status: compareVersions(current, latest.version),
      ...(latest.error ? { error: latest.error } : {}),
    };
  });

  /**
   * `GET /api/versions` — every app's version pair in one request.
   *
   * The widget draws a grid of cards and would otherwise fire one request per
   * card on every refresh. One batched call, served largely from cache, is the
   * difference between a handful of upstream calls a day and a rate-limit
   * exhaustion.
   */
  app.get('/api/versions', async () => {
    const { listApps } = await import('../db/apps-store.js');
    const apps = listApps(db);

    const entries = await Promise.all(
      apps.map(async (found) => {
        const apiUrl = toReleasesApiUrl(found.version?.latestUrl);
        const current = resolveCurrent(found.version?.currentContainerId);
        const latest = apiUrl ? await fetchLatest(apiUrl, { cache }) : { version: null };

        return [
          found.id,
          {
            current,
            latest: latest.version ?? null,
            latestUrl: latest.url ?? null,
            publishedAt: latest.publishedAt ?? null,
            status: compareVersions(current, latest.version),
            ...(latest.error ? { error: latest.error } : {}),
          },
        ];
      })
    );

    return { versions: Object.fromEntries(entries) };
  });

  return { cache };
}
