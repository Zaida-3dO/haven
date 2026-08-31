/**
 * The host's fetch layer: dedup, caching, and the stale fallback.
 *
 * The host fetches; widgets render. Everything about talking to the backend
 * lives here so there is exactly one place to fix a fetching bug, add auth, or
 * change cache policy.
 *
 * Note what is NOT here: no credentials. The shell only ever calls `/api/*`;
 * the backend holds every secret and talks to the upstream service. A token in
 * front-end code means the design has gone wrong.
 */

const DEFAULT_CACHE_MS = 30_000;

export class Fetcher {
  /** key -> Promise, for requests currently in flight. */
  #inflight = new Map();
  /** key -> { value, at }, the last successful response. */
  #cache = new Map();

  #transport;
  #now;
  #cacheMs;

  /** Counts real transport calls — the thing the dedup test asserts on. */
  requestCount = 0;

  constructor({ transport = defaultTransport, now = () => Date.now(), cacheMs } = {}) {
    this.#transport = transport;
    this.#now = now;
    this.#cacheMs = cacheMs ?? DEFAULT_CACHE_MS;
  }

  /**
   * Fetch `request`, deduplicating concurrent callers.
   *
   * Two widgets pointed at one endpoint must produce ONE request. Both the
   * in-flight map and the short cache serve that: simultaneous callers join the
   * same promise, and a caller arriving just after a response is served from
   * cache rather than re-hitting the backend.
   *
   * @param {{ key?: string, url: string, options?: object, cacheMs?: number }} request
   */
  async fetch(request) {
    const key = cacheKey(request);
    const cacheMs = request.cacheMs ?? this.#cacheMs;

    const cached = this.#cache.get(key);
    if (cached && this.#now() - cached.at < cacheMs) {
      return { value: cached.value, fromCache: true, stale: false };
    }

    const existing = this.#inflight.get(key);
    if (existing) {
      // Join the in-flight request rather than starting a second one.
      const value = await existing;
      return { value, fromCache: true, stale: false };
    }

    this.requestCount += 1;
    const promise = (async () => this.#transport(request))();
    this.#inflight.set(key, promise);

    try {
      const value = await promise;
      this.#cache.set(key, { value, at: this.#now() });
      return { value, fromCache: false, stale: false };
    } finally {
      // Always clear, or one failure would wedge the key permanently.
      this.#inflight.delete(key);
    }
  }

  /**
   * Fetch, falling back to stale cache when the request fails.
   *
   * A soft notice is not a hard error: if the backend is briefly down but we
   * hold a usable cached value, the caller gets `{ stale: true }` and renders
   * the data with a marker instead of an error box.
   */
  async fetchWithFallback(request) {
    try {
      return await this.fetch(request);
    } catch (error) {
      const cached = this.#cache.get(cacheKey(request));
      if (cached) {
        return { value: cached.value, fromCache: true, stale: true, error };
      }
      throw error;
    }
  }

  peek(request) {
    return this.#cache.get(cacheKey(request)) ?? null;
  }

  invalidate(request) {
    this.#cache.delete(cacheKey(request));
  }

  clear() {
    this.#cache.clear();
    this.#inflight.clear();
    this.requestCount = 0;
  }
}

/**
 * Requests collapse to one key. An explicit `key` wins; otherwise the URL plus
 * anything about the options that changes the response.
 */
export function cacheKey(request) {
  if (request.key) return request.key;
  const method = request.options?.method ?? 'GET';
  const body = request.options?.body ? JSON.stringify(request.options.body) : '';
  return `${method} ${request.url} ${body}`.trim();
}

async function defaultTransport({ url, options }) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  const type = response.headers?.get?.('content-type') ?? '';
  return type.includes('application/json') ? response.json() : response.text();
}
