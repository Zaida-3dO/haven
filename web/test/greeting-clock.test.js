import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClockTicker } from '../src/widgets/greeting/clock.js';

/**
 * A controllable interval and visibility pair, so the ticker is driven by hand
 * rather than by waiting. Nothing here sleeps.
 */
function harness({ hidden = false } = {}) {
  const state = { hidden, callbacks: [], intervals: 0, cleared: 0, fn: null, ms: null };

  const visibility = {
    isHidden: () => state.hidden,
    subscribe: (fn) => state.callbacks.push(fn),
    unsubscribe: (fn) => {
      state.callbacks = state.callbacks.filter((c) => c !== fn);
    },
  };

  const ticker = new ClockTicker({
    setIntervalFn: (fn, ms) => {
      state.intervals += 1;
      state.fn = fn;
      state.ms = ms;
      return 'timer-handle';
    },
    clearIntervalFn: () => {
      state.cleared += 1;
      state.fn = null;
    },
    intervalMs: 1000,
    visibility,
  });

  return {
    ticker,
    state,
    /** Fire the interval, as the browser would. */
    fire: () => state.fn?.(),
    /** Flip tab visibility and notify, as `visibilitychange` would. */
    setHidden(value) {
      state.hidden = value;
      for (const fn of [...state.callbacks]) fn();
    },
  };
}

test('no subscribers means no timer at all', () => {
  const { state } = harness();

  assert.equal(state.intervals, 0, 'an empty dashboard must not run a clock');
});

test('the first subscriber starts the one shared timer', () => {
  const { ticker, state } = harness();

  ticker.subscribe(() => {});
  ticker.subscribe(() => {});
  ticker.subscribe(() => {});

  assert.equal(state.intervals, 1, 'three clocks share one interval');
  assert.equal(ticker.size, 3);
});

test('every subscriber is called on a tick', () => {
  const { ticker, fire } = harness();
  const calls = [];

  ticker.subscribe(() => calls.push('a'));
  ticker.subscribe(() => calls.push('b'));
  fire();

  assert.deepEqual(calls, ['a', 'b']);
});

test('the last unsubscribe stops the timer', () => {
  const { ticker, state } = harness();

  const off = ticker.subscribe(() => {});
  assert.equal(state.cleared, 0);

  off();

  assert.equal(ticker.size, 0);
  assert.equal(state.cleared, 1, 'a removed widget must not leave a timer running');
});

test('unsubscribing one of several keeps the timer running', () => {
  const { ticker, state } = harness();

  const off = ticker.subscribe(() => {});
  ticker.subscribe(() => {});
  off();

  assert.equal(state.cleared, 0);
  assert.equal(ticker.size, 1);
});

// ── the property the contract actually cares about ───────────────────────

test('a hidden tab ticks nothing', () => {
  const { ticker, fire, setHidden } = harness();
  let ticks = 0;
  ticker.subscribe(() => (ticks += 1));

  setHidden(true);
  fire();
  fire();

  assert.equal(ticks, 0, 'a hidden tab must not run the clock');
  assert.equal(ticker.paused, true);
});

test('becoming visible catches up at once rather than waiting a full tick', () => {
  const { ticker, setHidden } = harness();
  let ticks = 0;
  ticker.subscribe(() => (ticks += 1));

  setHidden(true);
  setHidden(false);

  assert.equal(ticks, 1, 'the clock must not stay visibly wrong after focus');
  assert.equal(ticker.paused, false);
});

test('subscribing while already hidden starts paused', () => {
  const { ticker, fire } = harness({ hidden: true });
  let ticks = 0;

  ticker.subscribe(() => (ticks += 1));
  fire();

  assert.equal(ticks, 0);
  assert.equal(ticker.paused, true);
});

test('ticking resumes after the tab comes back', () => {
  const { ticker, fire, setHidden } = harness();
  let ticks = 0;
  ticker.subscribe(() => (ticks += 1));

  setHidden(true);
  fire();
  setHidden(false); // catch-up tick
  fire();

  assert.equal(ticks, 2);
});

test('one throwing subscriber does not stop the others', () => {
  const { ticker, fire } = harness();
  let survived = 0;

  ticker.subscribe(() => {
    throw new Error('broken widget');
  });
  ticker.subscribe(() => (survived += 1));

  assert.doesNotThrow(fire);
  assert.equal(survived, 1, 'a broken clock must not freeze its siblings');
});

test('the ticker unsubscribes from visibility when it stops', () => {
  const { ticker, state } = harness();

  const off = ticker.subscribe(() => {});
  assert.equal(state.callbacks.length, 1);

  off();

  assert.equal(state.callbacks.length, 0, 'a stopped ticker must not leak a listener');
});
