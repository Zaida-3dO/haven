/**
 * The hero's rotation clock.
 *
 * ## Why this is not `setInterval`, and not a third mechanism either
 *
 * The contract is emphatic that a widget owns no timer, and the host owns every
 * one. A carousel does not fit the host's DATA path for the same reason the
 * clock does not: `WidgetHost.onData` skips a redraw when `revision` is
 * unchanged, and `nextRevision` only advances when the fetched value differs.
 * The slide list at 10:00:08 is the same list as at 10:00:00, so a hero driven
 * by data alone would render slide one and sit there forever.
 *
 * The greeting widget already solved this shape with `ClockTicker` — one shared
 * interval, pausing with the tab, started by the first subscriber and stopped
 * by the last. This REUSES that class rather than inventing a third mechanism:
 * `HERO_TICK_MS` is its interval and the elapsed-time accounting below is what
 * turns a fixed 1s tick into a per-widget, configurable rotation.
 *
 * That indirection is the whole reason this file exists. The ticker's interval
 * is fixed at construction, but "seconds per slide" is per-widget config — two
 * heroes on one board may legitimately want 5s and 30s. Counting elapsed time
 * against each subscriber's own interval gives every hero its own rate off ONE
 * shared timer, instead of one timer per hero, which is the thing the contract
 * forbids.
 */

import { ClockTicker } from '../greeting/clock.js';

/**
 * The shared tick granularity — a resolution, not a rotation rate.
 *
 * One second, so a rotation lands within a second of its due time whatever the
 * configured interval. The alternative, a timer per configured rate, is exactly
 * the uncoordinated-timers problem the contract exists to prevent.
 */
export const HERO_TICK_MS = 1_000;

/** The one ticker every hero on the board shares. */
export const heroTicker = new ClockTicker({ intervalMs: HERO_TICK_MS });

/**
 * Subscribes a rotation callback that fires every `intervalMs` of *unpaused*
 * time, off the shared one-second tick.
 *
 * `shouldRotate()` is asked on every tick rather than the subscription being
 * torn down and rebuilt when hover or reduced-motion changes: the pause state
 * flips on mouse movement, and re-subscribing on every mouseenter would churn
 * the shared ticker's subscriber set several times a second.
 *
 * The elapsed counter RESETS while paused rather than accumulating. Hovering a
 * hero for a minute and leaving should not fire seven rotations in a row — the
 * clock on the slide you were reading starts again when you look away.
 *
 * @param {object} deps
 * @param {() => number} deps.intervalMs the configured rotation period
 * @param {() => boolean} deps.shouldRotate asked before every rotation
 * @param {() => void} deps.onRotate
 * @param {ClockTicker} [deps.ticker] injectable for tests
 * @param {() => number} [deps.now] injectable for tests
 * @returns {() => void} unsubscribe
 */
export function subscribeRotation({
  intervalMs,
  shouldRotate,
  onRotate,
  ticker = heroTicker,
  now = () => Date.now(),
}) {
  let last = now();

  return ticker.subscribe(() => {
    const at = now();

    if (!shouldRotate()) {
      // Paused: keep the window sliding forward so the pause does not bank
      // time and fire a burst of rotations the moment it lifts.
      last = at;
      return;
    }

    const period = intervalMs();
    if (!Number.isFinite(period) || period <= 0) return;

    if (at - last < period) return;
    last = at;
    onRotate();
  });
}
