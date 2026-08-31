/**
 * App status — the state of the dots, derived from the browser's own probe.
 *
 * THIS RUNS IN THE BROWSER, DELIBERATELY, and that is the whole feature. On a
 * split LAN/VPN network the server can reach a service the phone cannot, and
 * vice versa, so a server-side probe shows a green dot on something you cannot
 * open. A dot here means "reachable from where *you* are", which is the only
 * useful meaning. Nearly every off-the-shelf dashboard gets this wrong; see
 * `reachability.js` and docs/DESIGN.md §6.2 before moving any of this.
 *
 * ## What this adds over `reachability.js`
 *
 * `reachability.resolve()` answers "which URL should a click go to, and did
 * anything answer". This module is the state machine around that one call:
 *
 *  - It turns the answer into a dot state, a label and a hover hint.
 *  - It caches per app, so the dot and the click target come from the SAME
 *    probe. Probing once for the click target and again for the dot would
 *    double every app's network traffic and could disagree with itself.
 *  - It dedupes concurrent checks, so two renders of one card cannot start two
 *    probe chains.
 *
 * ## What this deliberately does NOT do
 *
 * It owns no timer. A widget must never call `setInterval` — the host's
 * `Scheduler` drives refreshes and pauses them when the tab is hidden. This
 * module exposes `checkAll()` for the host to call and nothing that schedules
 * itself.
 */

import { resolve as resolveReachability, candidates } from './reachability.js';

/**
 * The four dot states.
 *
 * `CHECKING` and `UNKNOWN` are distinct on purpose: "we are asking" and "we
 * have not asked / cannot ask" look the same to a naive implementation and
 * mean very different things to someone looking at a grey dot. An app with no
 * URLs at all is UNKNOWN and will never become anything else.
 */
export const STATUS = Object.freeze({
  REACHABLE: 'reachable',
  UNREACHABLE: 'unreachable',
  CHECKING: 'checking',
  UNKNOWN: 'unknown',
});

/**
 * Human labels.
 *
 * Colour must not carry the meaning alone — these become the dot's
 * `title` and `aria-label`, so the state is available to a screen reader and
 * to anyone who cannot distinguish the colours.
 */
export const STATUS_LABEL = Object.freeze({
  [STATUS.REACHABLE]: 'Reachable from here',
  [STATUS.UNREACHABLE]: 'Not reachable from here',
  [STATUS.CHECKING]: 'Checking…',
  [STATUS.UNKNOWN]: 'Reachability unknown',
});

/** How long a probe result is trusted before the next check re-probes. */
export const DEFAULT_STATUS_TTL_MS = 60_000;

/**
 * The hover hint: where a click will actually land.
 *
 * This matters precisely because the resolved target is often NOT the primary
 * URL — the chain may have fallen through to a Tailscale or LAN alias — so
 * without the hint the click target is invisible until you have already
 * clicked it.
 */
export function urlHint(entry) {
  if (!entry?.url) return 'No reachable URL';
  if (entry.status === STATUS.CHECKING) return `Checking ${entry.url}…`;
  if (entry.status === STATUS.UNREACHABLE) {
    // Still name the URL: "nothing answered, and this is what a click would
    // still try" is more useful than a bare "unreachable".
    return `Nothing answered — a click opens ${entry.url}`;
  }
  return `Opens ${entry.url}`;
}

/** The accessible description for one app's dot. */
export function statusLabel(entry, appName = '') {
  const base = STATUS_LABEL[entry?.status] ?? STATUS_LABEL[STATUS.UNKNOWN];
  return appName ? `${appName}: ${base}` : base;
}

/**
 * Tracks reachability for a set of apps.
 *
 * One instance per widget. It holds results, not timers: the host asks it to
 * check, and it answers. `onChange` fires whenever an entry's state changes so
 * the widget can patch that one dot rather than re-rendering the grid.
 */
export class StatusTracker {
  /** appId -> { status, url, checkedAt } */
  #entries = new Map();
  /** appId -> Promise, for checks currently running. */
  #inflight = new Map();

  #resolveFn;
  #now;
  #ttlMs;
  #onChange;

  constructor({
    // Injected so tests never touch the network. Defaults to the real
    // sequential priority chain — this module must not reimplement it.
    resolveFn = resolveReachability,
    now = () => Date.now(),
    ttlMs = DEFAULT_STATUS_TTL_MS,
    onChange = null,
  } = {}) {
    this.#resolveFn = resolveFn;
    this.#now = now;
    this.#ttlMs = ttlMs;
    this.#onChange = onChange;
  }

  /**
   * The current entry for an app, without probing.
   *
   * An app that has never been checked reads as UNKNOWN with its primary URL
   * as the click target, so a card can render immediately and correctly before
   * any probe finishes.
   */
  get(app) {
    const id = app?.id;
    const existing = id ? this.#entries.get(id) : null;
    if (existing) return existing;

    const first = candidates(app)[0] ?? null;
    return { status: STATUS.UNKNOWN, url: first, checkedAt: null };
  }

  /** Every known entry, for a full re-render. */
  snapshot() {
    return new Map(this.#entries);
  }

  /**
   * Probe one app and record the result.
   *
   * Two callers asking at once join the same probe rather than starting two
   * chains — the click target and the dot must come from one answer, or they
   * can disagree.
   */
  async check(app, { force = false } = {}) {
    const id = app?.id;
    if (!id) return this.get(app);

    // No URLs at all: permanently UNKNOWN. Probing nothing would report
    // "unreachable", which reads as a broken service rather than an
    // unconfigured one.
    if (candidates(app).length === 0) {
      return this.#set(id, { status: STATUS.UNKNOWN, url: null, checkedAt: this.#now() });
    }

    const existing = this.#entries.get(id);
    if (!force && existing && existing.checkedAt !== null) {
      if (this.#now() - existing.checkedAt < this.#ttlMs) return existing;
    }

    const running = this.#inflight.get(id);
    if (running) return running;

    // Show CHECKING but keep the last known URL, so the card stays clickable
    // while the probe runs instead of going dead for a few seconds.
    this.#set(id, {
      status: STATUS.CHECKING,
      url: existing?.url ?? candidates(app)[0] ?? null,
      checkedAt: existing?.checkedAt ?? null,
    });

    const promise = (async () => {
      try {
        const { online, url } = await this.#resolveFn(app);
        return this.#set(id, {
          status: online ? STATUS.REACHABLE : STATUS.UNREACHABLE,
          url,
          checkedAt: this.#now(),
        });
      } catch {
        // `resolve` is documented never to reject, but a probe failure must
        // not be able to wedge a card in CHECKING forever if that ever
        // changes.
        return this.#set(id, {
          status: STATUS.UNKNOWN,
          url: candidates(app)[0] ?? null,
          checkedAt: this.#now(),
        });
      } finally {
        this.#inflight.delete(id);
      }
    })();

    this.#inflight.set(id, promise);
    return promise;
  }

  /**
   * Probe a list of apps.
   *
   * Apps are probed CONCURRENTLY with each other, while each app's own URL
   * variants are probed sequentially inside `resolve`. That split is the point:
   * the sequential part is what avoids fetching every variant of one app (and
   * the mixed-content console noise that comes with it), but there is no reason
   * for one slow host to delay a different app's dot.
   */
  async checkAll(apps = [], options = {}) {
    return Promise.all(apps.map((app) => this.check(app, options)));
  }

  /** Drop everything — used when the widget's app list changes wholesale. */
  clear() {
    this.#entries.clear();
    this.#inflight.clear();
  }

  #set(id, entry) {
    const previous = this.#entries.get(id);
    this.#entries.set(id, entry);
    if (!previous || previous.status !== entry.status || previous.url !== entry.url) {
      this.#onChange?.(id, entry, previous ?? null);
    }
    return entry;
  }
}

export default { STATUS, STATUS_LABEL, StatusTracker, urlHint, statusLabel };
