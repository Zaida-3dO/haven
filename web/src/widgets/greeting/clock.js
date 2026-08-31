/**
 * The clock tick — host-owned, shared, and pausable.
 *
 * ## Why this file exists
 *
 * The contract is emphatic that a widget must never call `setInterval`, and
 * the host owns every timer. For a data-driven widget that is the end of it:
 * the scheduler refetches, `onData()` fires, the widget redraws.
 *
 * A clock does not fit that shape, and the host's own correctness is the
 * reason. `WidgetHost.onData` deliberately skips a redraw when the payload's
 * `revision` is unchanged, and `nextRevision` only advances when the fetched
 * value actually differs. That rule is right — it is what stops a data tick
 * blowing away the 3D scene's canvas — but it means a widget whose display
 * changes with the WALL CLOCK rather than with its data is never asked to
 * redraw. Weather at 10:00:01 is the same weather as at 10:00:00, so the
 * greeting widget would render once and then show a frozen time.
 *
 * So the tick is a separate concern from the data, and this is where it
 * lives: ONE interval shared by every clock-like widget, which pauses with the
 * tab exactly as the scheduler does. It is still host-owned rather than
 * widget-owned — twenty greeting widgets would share this one timer — and no
 * widget below it ever touches `setInterval`.
 *
 * If the widget host later grows a first-class "redraw on a schedule" hook,
 * this should collapse into it; the widget only depends on being called, not
 * on what calls it.
 */

/** A minute is the resolution the greeting actually needs. */
export const MINUTE_MS = 60_000;

export class ClockTicker {
  #subscribers = new Set();
  #timer = null;
  #paused = false;

  #setInterval;
  #clearInterval;
  #intervalMs;
  #visibility;
  #onVisibilityChange = null;

  /**
   * Everything is injected so the ticker runs headless in a test with no
   * `document` and no real waiting.
   */
  constructor({
    setIntervalFn = globalThis.setInterval?.bind(globalThis),
    clearIntervalFn = globalThis.clearInterval?.bind(globalThis),
    intervalMs = 1000,
    visibility = defaultVisibility(),
  } = {}) {
    this.#setInterval = setIntervalFn;
    this.#clearInterval = clearIntervalFn;
    this.#intervalMs = intervalMs;
    this.#visibility = visibility;
  }

  get size() {
    return this.#subscribers.size;
  }

  get running() {
    return this.#timer !== null;
  }

  get paused() {
    return this.#paused;
  }

  /**
   * Subscribe a redraw. The timer starts with the first subscriber and stops
   * with the last, so an empty dashboard runs no timer at all.
   *
   * @returns {() => void} unsubscribe
   */
  subscribe(fn) {
    this.#subscribers.add(fn);
    if (this.#subscribers.size === 1) this.#start();
    return () => this.unsubscribe(fn);
  }

  unsubscribe(fn) {
    this.#subscribers.delete(fn);
    if (this.#subscribers.size === 0) this.stop();
  }

  /** One pass. A throwing subscriber must not stop the others ticking. */
  tick() {
    if (this.#paused) return 0;
    let ran = 0;
    for (const fn of this.#subscribers) {
      try {
        fn();
        ran += 1;
      } catch {
        // The host's error boundary owns what a broken widget looks like;
        // here we only make sure one of them cannot freeze every clock.
      }
    }
    return ran;
  }

  #start() {
    if (this.#timer !== null || !this.#setInterval) return;

    this.#paused = this.#visibility.isHidden();
    this.#onVisibilityChange = () => {
      this.#paused = this.#visibility.isHidden();
      // Catch up immediately on becoming visible, so the clock is never
      // briefly wrong after the tab is focused.
      if (!this.#paused) this.tick();
    };
    this.#visibility.subscribe(this.#onVisibilityChange);

    this.#timer = this.#setInterval(() => this.tick(), this.#intervalMs);
    // Never hold a Node test process open on the tick.
    this.#timer?.unref?.();
  }

  stop() {
    if (this.#timer !== null) {
      this.#clearInterval?.(this.#timer);
      this.#timer = null;
    }
    if (this.#onVisibilityChange) {
      this.#visibility.unsubscribe(this.#onVisibilityChange);
      this.#onVisibilityChange = null;
    }
  }
}

/** Mirrors the scheduler's own wiring: with no `document`, never hidden. */
export function defaultVisibility() {
  const doc = globalThis.document;
  if (!doc) return { isHidden: () => false, subscribe() {}, unsubscribe() {} };
  return {
    isHidden: () => doc.visibilityState === 'hidden',
    subscribe: (fn) => doc.addEventListener('visibilitychange', fn),
    unsubscribe: (fn) => doc.removeEventListener('visibilitychange', fn),
  };
}

/** The shared ticker every clock-like widget uses. */
export const clockTicker = new ClockTicker();
