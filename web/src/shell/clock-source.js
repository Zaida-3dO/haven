/**
 * The clock's time source — a **host-owned** scheduler task.
 *
 * This exists so the clock widget can update every second without owning a
 * timer, which the contract forbids outright. It is the shell's job, so it
 * lives in the shell.
 *
 * A widget's usual route to data is `dataSource(config)` → `Fetcher` → HTTP.
 * The current time has no endpoint and needs none, so instead the scheduler —
 * the single owner of every timer in Haven — runs a task that reads the clock
 * and pushes a `PanelData` payload into the host. The widget receives it
 * through `onData` exactly as a fetched widget does, and cannot tell the
 * difference.
 *
 * The properties that matter all come from being on the shared scheduler:
 * the tick stops when the tab is hidden, resumes with a single catch-up pass
 * rather than a burst, and there is still exactly one timer in the page no
 * matter how many clocks are on the dashboard.
 */

import { doneData } from './panel-data.js';

/** How often the clock face updates. */
export const CLOCK_TICK_MS = 1_000;

/**
 * Registers a scheduler task that pushes the current time into one clock.
 *
 * @param {object} deps
 * @param {import('./scheduler.js').Scheduler} deps.scheduler
 * @param {import('./host.js').WidgetHost} deps.host the clock's host
 * @param {() => number} [deps.now]
 * @returns {() => void} teardown
 */
export function startClockTicks({ scheduler, host, now = () => Date.now() }) {
  const taskId = `clock-tick:${host.id}`;
  let previous = null;

  const push = () => {
    // `doneData` bumps the revision only when the value actually changed, so
    // the host's revision check keeps working: a second that has not ticked
    // over does not cause a re-render.
    previous = doneData({ timestamp: now() }, { previous });
    host.onData(previous);
  };

  scheduler.add(taskId, {
    intervalMs: CLOCK_TICK_MS,
    update: async () => push(),
  });

  // Paint immediately rather than showing a placeholder for a whole second.
  push();

  return () => scheduler.remove(taskId);
}
