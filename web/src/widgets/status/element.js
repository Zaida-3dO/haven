/**
 * The overall-status widget — "23 Online / 0 Offline", pinned to the bottom of
 * the sidebar the way the dashboard Haven replaces pins its own.
 *
 * It counts the SAME browser-side probes that drive the app cards' dots, so
 * the summary and the dots can never disagree. See `definition.js` for why
 * that is not a nicety.
 *
 * ## How this obeys the contract
 *
 *  - **The host fetches; this renders.** `dataSource` describes the apps
 *    registry request; the dashboard performs it and pushes it to `onData`.
 *  - **No `setInterval` anywhere.** Re-probes happen on the host's data push.
 *  - **Diff and patch.** A probe resolving patches the two numbers in place
 *    rather than rebuilding the card, so the counts tick up without the tile
 *    flickering.
 */

import { STATUS, StatusTracker } from '../../lib/status.js';
import { countStatuses } from './count.js';
import { STATUS_STYLES } from './styles.js';

/**
 * See the identical note in `apps-widget.js`: under `node --test` there is no
 * `HTMLElement`, and extending an undefined global is a module-load error that
 * would take this file's pure exports down with it.
 */
const ElementBase =
  typeof HTMLElement === 'function'
    ? HTMLElement
    : class {
        attachShadow() {
          return null;
        }
      };

export class HavenStatusWidget extends ElementBase {
  #apps = [];
  #tracker = null;
  #trackerTtlMs = null;
  #shadow = null;

  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: 'open' });
  }

  setConfig(config = {}) {
    if (config === null || typeof config !== 'object') {
      throw new Error('status: config must be an object');
    }

    // Rebuilt only when the TTL actually changes — a new tracker starts with
    // no results, so rebuilding on every `setConfig` would reset the count to
    // "nothing known" and re-probe the whole registry on a config touch that
    // had nothing to do with reachability.
    const ttlMs = config.statusTtlMs ?? 60_000;
    if (!this.#tracker || this.#trackerTtlMs !== ttlMs) {
      this.#trackerTtlMs = ttlMs;
      this.#tracker = new StatusTracker({
        ttlMs,
        onChange: () => this.#patchCounts(),
      });
    }
  }

  onData(data) {
    const value = data?.value;
    this.#apps = Array.isArray(value) ? value : (value?.apps ?? []);
    void this.#tracker?.checkAll(this.#apps);
    this.render();
  }

  /** The counts as they stand, so a test can assert without reading the DOM. */
  get counts() {
    return countStatuses(this.#apps, this.#tracker?.snapshot() ?? null);
  }

  render() {
    if (!this.#shadow) return;

    const style = document.createElement('style');
    style.textContent = STATUS_STYLES;

    const root = document.createElement('div');
    root.className = 'summary';

    root.appendChild(this.#renderCount('online', 'Online'));
    root.appendChild(this.#renderCount('offline', 'Offline'));

    this.#shadow.replaceChildren(style, root);
    this.#patchCounts();
  }

  #renderCount(kind, label) {
    const wrap = document.createElement('span');
    wrap.className = `count count--${kind}`;

    const dot = document.createElement('span');
    dot.className = `count__dot count__dot--${kind}`;
    dot.setAttribute('aria-hidden', 'true');

    const value = document.createElement('span');
    value.className = 'count__value';
    value.dataset.count = kind;
    value.textContent = '0';

    const text = document.createElement('span');
    text.className = 'count__label';
    text.textContent = label;

    wrap.append(dot, value, text);
    return wrap;
  }

  /**
   * Patch the two numbers in place.
   *
   * The whole card is not re-rendered: probes resolve one at a time, and
   * rebuilding on each would make the tile flicker for as long as the sweep
   * takes.
   */
  #patchCounts() {
    const root = this.#shadow;
    if (!root?.querySelector) return;

    const { online, offline, total, pending } = this.counts;

    const onlineEl = root.querySelector('[data-count="online"]');
    if (onlineEl) onlineEl.textContent = String(online);

    const offlineEl = root.querySelector('[data-count="offline"]');
    if (offlineEl) offlineEl.textContent = String(offline);

    // While probes are outstanding the card says so, rather than presenting a
    // partial count as if it were the final one.
    const summary = root.querySelector('.summary');
    if (summary) {
      summary.classList.toggle('summary--pending', pending > 0);
      summary.setAttribute(
        'aria-label',
        pending > 0
          ? `${online} online, ${offline} offline, ${pending} of ${total} still being checked`
          : `${online} online, ${offline} offline`
      );
    }
  }

  onResize() {
    // Two numbers in a flex row; nothing to recompute. The hook exists so the
    // contract is satisfied explicitly rather than by omission.
  }

  destroy() {
    this.#tracker?.clear();
    this.#tracker = null;
    this.#shadow?.replaceChildren?.();
  }
}

export { STATUS, countStatuses };
