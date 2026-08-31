import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { ClockTicker } from '../src/widgets/greeting/clock.js';
import { subscribeRotation, HERO_TICK_MS, heroTicker } from '../src/widgets/hero/rotation.js';

/**
 * A hand-driven ticker and clock, so the rotation is asserted by advancing a
 * number rather than by waiting. Nothing here sleeps.
 */
function harness({ intervalMs = 8000, reducedMotion = false } = {}) {
  const state = { now: 0, rotations: 0, paused: false, fn: null };

  const ticker = new ClockTicker({
    setIntervalFn: (fn) => {
      state.fn = fn;
      return 'handle';
    },
    clearIntervalFn: () => {
      state.fn = null;
    },
    intervalMs: HERO_TICK_MS,
    visibility: { isHidden: () => false, subscribe() {}, unsubscribe() {} },
  });

  const unsubscribe = subscribeRotation({
    intervalMs: () => intervalMs,
    shouldRotate: () => !state.paused && !reducedMotion,
    onRotate: () => void (state.rotations += 1),
    ticker,
    now: () => state.now,
  });

  return {
    state,
    unsubscribe,
    ticker,
    /** Advance the clock by `ms` and fire one tick per simulated second. */
    advance(ms) {
      for (let elapsed = 0; elapsed < ms; elapsed += HERO_TICK_MS) {
        state.now += HERO_TICK_MS;
        state.fn?.();
      }
    },
  };
}

describe('subscribeRotation', () => {
  test('rotates once per configured interval, not once per tick', () => {
    // The distinction the whole file exists for: the shared ticker fires every
    // second, but the hero rotates every `rotateSeconds`.
    const h = harness({ intervalMs: 8000 });

    h.advance(7000);
    assert.equal(h.state.rotations, 0, 'must not rotate before the interval elapses');

    h.advance(1000);
    assert.equal(h.state.rotations, 1);

    h.advance(8000);
    assert.equal(h.state.rotations, 2);
  });

  test('two subscribers at different rates share ONE ticker', () => {
    // This is the reason for the elapsed-time accounting: ClockTicker's own
    // interval is fixed at construction, so per-widget rates have to come from
    // counting, not from a second timer.
    const state = { now: 0, fast: 0, slow: 0, fn: null };
    const ticker = new ClockTicker({
      setIntervalFn: (fn) => {
        state.fn = fn;
        return 'handle';
      },
      clearIntervalFn: () => {
        state.fn = null;
      },
      intervalMs: HERO_TICK_MS,
      visibility: { isHidden: () => false, subscribe() {}, unsubscribe() {} },
    });

    subscribeRotation({
      intervalMs: () => 2000,
      shouldRotate: () => true,
      onRotate: () => void (state.fast += 1),
      ticker,
      now: () => state.now,
    });
    subscribeRotation({
      intervalMs: () => 10_000,
      shouldRotate: () => true,
      onRotate: () => void (state.slow += 1),
      ticker,
      now: () => state.now,
    });

    assert.equal(ticker.size, 2, 'both heroes subscribe to the same ticker');

    for (let i = 0; i < 10; i++) {
      state.now += HERO_TICK_MS;
      state.fn?.();
    }

    assert.equal(state.fast, 5, '10s at 2s per slide');
    assert.equal(state.slow, 1, '10s at 10s per slide');
  });

  test('a pause stops rotation while it lasts', () => {
    const h = harness({ intervalMs: 4000 });

    h.state.paused = true;
    h.advance(20_000);
    assert.equal(h.state.rotations, 0, 'a hovered hero must not advance');
  });

  test('a long pause does NOT bank time and fire a burst when it lifts', () => {
    // Hovering for a minute then leaving should not rattle through fifteen
    // slides — the slide you were reading gets its full interval from the
    // moment you look away.
    const h = harness({ intervalMs: 4000 });

    h.state.paused = true;
    h.advance(60_000);
    h.state.paused = false;

    h.advance(3000);
    assert.equal(h.state.rotations, 0, 'the pause must not have banked any time');

    h.advance(1000);
    assert.equal(h.state.rotations, 1, 'and then it resumes normally');
  });

  test('reduced motion means it never rotates on its own', () => {
    const h = harness({ intervalMs: 1000, reducedMotion: true });
    h.advance(60_000);
    assert.equal(h.state.rotations, 0);
  });

  test('a nonsensical interval is ignored rather than rotating every tick', () => {
    const state = { now: 0, rotations: 0, fn: null };
    const ticker = new ClockTicker({
      setIntervalFn: (fn) => {
        state.fn = fn;
        return 'handle';
      },
      clearIntervalFn: () => {},
      intervalMs: HERO_TICK_MS,
      visibility: { isHidden: () => false, subscribe() {}, unsubscribe() {} },
    });

    subscribeRotation({
      intervalMs: () => 0,
      shouldRotate: () => true,
      onRotate: () => void (state.rotations += 1),
      ticker,
      now: () => state.now,
    });

    for (let i = 0; i < 10; i++) {
      state.now += HERO_TICK_MS;
      state.fn?.();
    }

    assert.equal(state.rotations, 0, 'a zero interval must not mean "every tick"');
  });

  test('unsubscribing stops the timer with the last subscriber', () => {
    const h = harness();
    assert.equal(h.ticker.running, true);

    h.unsubscribe();

    assert.equal(h.ticker.size, 0);
    assert.equal(h.ticker.running, false, 'an empty dashboard runs no timer at all');
  });
});

describe('the shared hero ticker', () => {
  test('ticks once a second — a resolution, not a rotation rate', () => {
    assert.equal(HERO_TICK_MS, 1000);
  });

  test('is a ClockTicker, reusing the greeting widget mechanism', () => {
    // Reused rather than reinvented: the contract forbids a widget owning a
    // timer, and a third mechanism would be a third thing to get wrong.
    assert.ok(heroTicker instanceof ClockTicker);
  });
});

describe('the hero owns no timer of its own', () => {
  // The contract's hardest rule, and a carousel is the second most tempting
  // widget to break it in after a clock. Scanned with comments stripped,
  // because these files discuss timers at length in prose.
  const files = ['element.js', 'slides.js', 'definition.js', 'rotation.js'];

  for (const file of files) {
    test(`${file} schedules nothing itself`, async () => {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(new URL(`../src/widgets/hero/${file}`, import.meta.url), 'utf8');
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      assert.ok(
        !/\b(setInterval|setTimeout|requestAnimationFrame)\s*\(/.test(code),
        `${file} must not schedule its own work — the host owns every timer`
      );
    });
  }
});
