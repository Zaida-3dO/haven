/**
 * Counting reachability — the pure half of the status widget.
 *
 * Kept out of `element.js` so the arithmetic can be asserted under
 * `node --test` without a custom-element registry. The element does nothing
 * but render what this returns.
 */

import { STATUS } from '../../lib/status.js';

/**
 * Tally a set of apps against a map of probe results.
 *
 * ## Why "pending" is its own bucket rather than folded into offline
 *
 * A probe that has not finished is NOT an offline service, and counting it as
 * one is how a dashboard comes to say "0 Online / 23 Offline" for a second
 * every time it loads — a genuinely alarming thing to flash at someone whose
 * whole network is fine. `CHECKING` and `UNKNOWN` are both pending here:
 * "asking" and "cannot ask" are equally not-an-answer as far as a count goes.
 *
 * The live dashboard shows only the two numbers, so `pending` is not rendered
 * as a third figure — but it is returned, because `online + offline` not
 * summing to `total` is exactly the state the caller needs to know about to
 * avoid claiming a complete picture it does not have.
 *
 * @param {Array<{id?: string}>} apps
 * @param {Map<string, {status?: string}>|null} statuses keyed by app id
 * @returns {{total: number, online: number, offline: number, pending: number, settled: boolean}}
 */
export function countStatuses(apps = [], statuses = null) {
  const list = Array.isArray(apps) ? apps.filter((app) => app && app.id != null) : [];

  let online = 0;
  let offline = 0;

  for (const app of list) {
    // `statuses` may be a Map or a plain object depending on the caller; the
    // tracker hands out a Map, and a test fixture is more readable as an
    // object. Both are read the same way here.
    const entry =
      typeof statuses?.get === 'function' ? statuses.get(app.id) : (statuses?.[app.id] ?? null);

    if (entry?.status === STATUS.REACHABLE) online += 1;
    else if (entry?.status === STATUS.UNREACHABLE) offline += 1;
    // Everything else — CHECKING, UNKNOWN, no entry at all — is pending.
  }

  const total = list.length;
  const pending = total - online - offline;

  return {
    total,
    online,
    offline,
    pending,
    /** True once every app has a definite answer. */
    settled: total > 0 && pending === 0,
  };
}

export default { countStatuses };
