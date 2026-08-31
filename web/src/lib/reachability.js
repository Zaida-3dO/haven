/**
 * Reachability resolution.
 *
 * For an app with multiple URL variants, probes them in priority order and
 * returns the first that responds — the canonical URL for this session and
 * this location. Ported near-verbatim from the old dashboard's
 * `js/reachability.js`; the behaviour below is carried over deliberately and
 * should not be "tidied up" without reading docs/DESIGN.md §6.2 first.
 *
 * THIS RUNS IN THE BROWSER, DELIBERATELY. Do not move it server-side. On a
 * split LAN/VPN network the server can reach services the phone cannot, so a
 * server-side probe shows a green dot on something you cannot actually open.
 * A status dot here means "reachable from where *you* are", which is the only
 * useful meaning. Nearly every off-the-shelf dashboard gets this wrong.
 *
 * Three things that look like omissions and are not:
 *
 *  1. Probes run SEQUENTIALLY, not in parallel. Parallel probing would be
 *     faster, but it fetches every variant every time — see (2).
 *
 *  2. Once a higher-priority variant answers, the lower-priority ones are
 *     NEVER fetched. At home the https alias answers first, so the http://
 *     variants are never probed and the console stays free of mixed-content
 *     net::ERR noise. Browser mixed-content blocking means an https page
 *     cannot probe an http:// variant anyway — those simply count as
 *     unreachable, which is correct: at home the https alias wins, and when
 *     away (dashboard opened over http via Tailscale) the http variants are
 *     probeable again.
 *
 *  3. `no-cors` HEAD is used rather than a real request. A reachable server
 *     resolves the promise with an opaque response; an unreachable one
 *     rejects. We never read the response — only whether it resolved.
 */

/** Per-probe timeout. A dead host must not stall the rest of the chain. */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Priority-ordered, de-duplicated list of an app's URL variants.
 *
 * The registry stores `urls` as an ORDERED array (docs/DESIGN.md §6.2), so
 * unlike the old dashboard — which reconstructed priority from four fixed
 * fields (localUrl|url, localIpUrl, remoteUrl, tailscaleUrl) — the order is
 * already the priority. `scripts/migrate-apps.mjs` is what puts the old fields
 * into that order, so the resulting sequence is the same one.
 *
 * @param {{ urls?: Array<{ url?: string }> }} app
 * @returns {string[]}
 */
export function candidates(app) {
  const list = Array.isArray(app?.urls) ? app.urls : [];
  const seen = new Set();
  const out = [];

  for (const entry of list) {
    const url = typeof entry === 'string' ? entry : entry?.url;
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }

  return out;
}

/**
 * Probes a single URL.
 *
 * Resolves `true` if the host responded at all, `false` on error or timeout.
 * Never rejects — the caller walks a chain and must not have it broken by one
 * dead host.
 *
 * @param {string} url
 * @param {number} [timeout]
 * @returns {Promise<boolean>}
 */
export function probe(url, timeout = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;

    const settle = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      if (done) return;
      // Abort the in-flight request as well as giving up on it, so a dead host
      // does not hold a connection open behind us.
      controller?.abort();
      settle(false);
    }, timeout);

    fetch(url, { method: 'HEAD', mode: 'no-cors', signal: controller?.signal })
      .then(() => settle(true))
      .catch(() => settle(false));
  });
}

/**
 * Probes an app's variants sequentially in priority order, stopping at the
 * first that responds.
 *
 * Returns the highest-priority reachable URL and — importantly — never fetches
 * the lower-priority variants once a higher one works. This is better than
 * probing only the primary URL, which is what most dashboards do: it is why
 * the dashboard works from home, from mobile data, and over Tailscale without
 * split-horizon DNS.
 *
 * Falls back to `{ online: false, url: <first candidate> }` when nothing
 * answers, so a click still has somewhere to go.
 *
 * @param {object} app
 * @param {number} [timeout] per-probe timeout, not a budget for the whole chain
 * @returns {Promise<{ online: boolean, url: string | null }>}
 */
export async function resolve(app, timeout = DEFAULT_TIMEOUT_MS) {
  const cands = candidates(app);
  if (!cands.length) return { online: false, url: null };

  for (const url of cands) {
    // Sequential on purpose: `await` in a loop is the behaviour, not an
    // oversight. See the header note.
    const ok = await probe(url, timeout);
    if (ok) return { online: true, url };
  }

  return { online: false, url: cands[0] };
}

export default { candidates, probe, resolve, DEFAULT_TIMEOUT_MS };
