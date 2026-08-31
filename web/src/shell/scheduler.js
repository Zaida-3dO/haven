/**
 * The refresh scheduler — the single owner of every timer in Haven.
 *
 * A widget must NEVER call `setInterval`. Twenty widgets with their own timers
 * is twenty uncoordinated polls with no backoff that keep running in a hidden
 * tab; it is the single easiest way to get this design wrong. So there is one
 * timer here, and it drives every refresh.
 *
 * Three things this does that per-widget timers structurally cannot:
 *
 *   1. Pause on `visibilitychange`. A hidden tab polls nothing. On show, any
 *      task whose interval elapsed while hidden runs once — not once per
 *      missed tick, which would stampede the backend after a long absence.
 *   2. Exponential backoff on failure, so a dead connector is retried on a
 *      widening interval instead of hammered every `refreshMs`.
 *   3. Ask before doing work. Glance splits `requiresUpdate(now) -> bool` from
 *      `update(ctx)`; the host asks first, which makes cache policy the host's
 *      business rather than each widget's.
 *
 * The tick interval is a granularity, not a poll rate: on each tick the
 * scheduler asks each task whether it is due. Timer injection keeps this
 * testable without waiting in real time.
 */

const DEFAULT_TICK_MS = 1_000;
const DEFAULT_BACKOFF_BASE_MS = 5_000;
const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000;

export class Scheduler {
  #tasks = new Map();
  #timer = null;
  #running = false;
  #paused = false;

  #now;
  #setInterval;
  #clearInterval;
  #tickMs;
  #backoffBaseMs;
  #backoffMaxMs;
  #visibility;
  #onVisibilityChange = null;

  constructor({
    now = () => Date.now(),
    setIntervalFn = globalThis.setInterval.bind(globalThis),
    clearIntervalFn = globalThis.clearInterval.bind(globalThis),
    tickMs = DEFAULT_TICK_MS,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
    backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
    // Injected so the scheduler can be driven in a test with no `document`.
    visibility = defaultVisibility(),
  } = {}) {
    this.#now = now;
    this.#setInterval = setIntervalFn;
    this.#clearInterval = clearIntervalFn;
    this.#tickMs = tickMs;
    this.#backoffBaseMs = backoffBaseMs;
    this.#backoffMaxMs = backoffMaxMs;
    this.#visibility = visibility;
  }

  get running() {
    return this.#running;
  }

  get paused() {
    return this.#paused;
  }

  get size() {
    return this.#tasks.size;
  }

  /**
   * Register a refresh task.
   *
   * @param {string} id Widget instance id.
   * @param {object} task
   * @param {number|null} task.intervalMs `refreshMs`; null/0 = never on a timer.
   * @param {(ctx) => Promise<void>} task.update The work itself.
   * @param {(now: number) => boolean} [task.requiresUpdate] Optional override;
   *   the host asks this before calling `update`.
   */
  add(id, { intervalMs, update, requiresUpdate } = {}) {
    if (typeof update !== 'function') {
      throw new Error(`Scheduler.add("${id}"): update must be a function`);
    }
    this.#tasks.set(id, {
      id,
      intervalMs: intervalMs || null,
      update,
      requiresUpdate: requiresUpdate ?? null,
      lastRunAt: null,
      failures: 0,
      // When set, the task is backing off and will not run before this time.
      retryAfter: null,
      inFlight: false,
    });
  }

  remove(id) {
    this.#tasks.delete(id);
  }

  has(id) {
    return this.#tasks.has(id);
  }

  /** Run a task now regardless of schedule — used for the first paint. */
  async runNow(id) {
    const task = this.#tasks.get(id);
    if (task) await this.#run(task);
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#paused = this.#visibility.isHidden();

    this.#onVisibilityChange = () => {
      if (this.#visibility.isHidden()) this.pause();
      else this.resume();
    };
    this.#visibility.subscribe(this.#onVisibilityChange);

    this.#timer = this.#setInterval(() => this.tick(), this.#tickMs);
  }

  stop() {
    if (!this.#running) return;
    this.#running = false;
    if (this.#timer !== null) {
      this.#clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#onVisibilityChange) {
      this.#visibility.unsubscribe(this.#onVisibilityChange);
      this.#onVisibilityChange = null;
    }
  }

  /**
   * Pause every refresh. The timer keeps ticking but every tick is a no-op —
   * the important property is that no request leaves the browser while the tab
   * is hidden.
   */
  pause() {
    this.#paused = true;
  }

  /**
   * Resume, and catch up ONCE for anything that came due while hidden.
   *
   * Deliberately not once per missed interval: a tab hidden overnight would
   * otherwise fire hundreds of queued refreshes at the backend the moment it
   * is focused.
   */
  resume() {
    if (!this.#paused) return;
    this.#paused = false;
    this.tick();
  }

  /** One pass: ask every task whether it is due, run the ones that are. */
  tick() {
    if (!this.#running || this.#paused) return [];

    const now = this.#now();
    const ran = [];
    for (const task of this.#tasks.values()) {
      if (!this.#isDue(task, now)) continue;
      ran.push(task.id);
      void this.#run(task);
    }
    return ran;
  }

  /**
   * `requiresUpdate(now) -> bool`, split from `update(ctx)`.
   *
   * The host asks before doing work, so a widget can decline (a clock that has
   * its own cheap cache, say) without the host having to know why.
   */
  #isDue(task, now) {
    if (task.inFlight) return false;
    // Backing off after a failure: nothing runs until the retry time.
    if (task.retryAfter !== null && now < task.retryAfter) return false;

    if (typeof task.requiresUpdate === 'function') {
      try {
        if (!task.requiresUpdate(now)) return false;
      } catch {
        // A widget that throws in `requiresUpdate` should not wedge the whole
        // schedule; fall through to the interval rule.
      }
    }

    if (task.retryAfter !== null) return true;
    if (!task.intervalMs) return false;
    if (task.lastRunAt === null) return true;
    return now - task.lastRunAt >= task.intervalMs;
  }

  async #run(task) {
    task.inFlight = true;
    task.lastRunAt = this.#now();
    try {
      await task.update({ now: task.lastRunAt, id: task.id });
      task.failures = 0;
      task.retryAfter = null;
    } catch {
      // Backoff: a failing endpoint is retried on a widening interval rather
      // than hammered once per `refreshMs`. The error itself is the host's
      // business — it has already been turned into an error payload upstream.
      task.failures += 1;
      task.retryAfter = this.#now() + this.backoffFor(task.failures);
    } finally {
      task.inFlight = false;
    }
  }

  /** Exponential, capped: base * 2^(n-1), never above `backoffMaxMs`. */
  backoffFor(failures) {
    const delay = this.#backoffBaseMs * 2 ** Math.max(0, failures - 1);
    return Math.min(delay, this.#backoffMaxMs);
  }

  /** Test/telemetry seam. */
  inspect(id) {
    const task = this.#tasks.get(id);
    if (!task) return null;
    return {
      id: task.id,
      intervalMs: task.intervalMs,
      lastRunAt: task.lastRunAt,
      failures: task.failures,
      retryAfter: task.retryAfter,
    };
  }
}

/**
 * `visibilitychange` wiring, isolated so the scheduler runs headless in tests.
 * With no `document` the tab is treated as always visible.
 */
export function defaultVisibility() {
  const doc = globalThis.document;
  if (!doc) {
    return { isHidden: () => false, subscribe() {}, unsubscribe() {} };
  }
  return {
    isHidden: () => doc.visibilityState === 'hidden',
    subscribe: (fn) => doc.addEventListener('visibilitychange', fn),
    unsubscribe: (fn) => doc.removeEventListener('visibilitychange', fn),
  };
}
