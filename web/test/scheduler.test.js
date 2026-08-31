import test from 'node:test';
import assert from 'node:assert/strict';

import { Scheduler } from '../src/shell/scheduler.js';

/**
 * A controllable clock and a fake `visibilitychange` source, so the timer
 * behaviour can be asserted without waiting in real time.
 */
function harness({ tickMs = 1000, backoffBaseMs = 5000, backoffMaxMs = 300000 } = {}) {
  let now = 0;
  let hidden = false;
  const listeners = new Set();

  const visibility = {
    isHidden: () => hidden,
    subscribe: (fn) => listeners.add(fn),
    unsubscribe: (fn) => listeners.delete(fn),
  };

  const scheduler = new Scheduler({
    now: () => now,
    // The tick is driven by hand; the interval itself is never used.
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    tickMs,
    backoffBaseMs,
    backoffMaxMs,
    visibility,
  });

  return {
    scheduler,
    advance(ms) {
      now += ms;
    },
    get now() {
      return now;
    },
    hide() {
      hidden = true;
      for (const fn of listeners) fn();
    },
    show() {
      hidden = false;
      for (const fn of listeners) fn();
    },
  };
}

// Let queued microtasks and resolved promises drain before asserting.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a task runs on its interval and not before', async () => {
  const h = harness();
  let runs = 0;
  h.scheduler.add('w1', { intervalMs: 60_000, update: async () => void runs++ });
  h.scheduler.start();

  h.scheduler.tick(); // first run — never fetched before
  await settle();
  assert.equal(runs, 1);

  h.advance(30_000);
  h.scheduler.tick();
  await settle();
  assert.equal(runs, 1, 'not due yet at half the interval');

  h.advance(30_000);
  h.scheduler.tick();
  await settle();
  assert.equal(runs, 2, 'due once the full interval has elapsed');
});

test('timers pause when the tab is hidden and resume when it is shown', async () => {
  const h = harness();
  let runs = 0;
  h.scheduler.add('w1', { intervalMs: 10_000, update: async () => void runs++ });
  h.scheduler.start();

  h.scheduler.tick();
  await settle();
  assert.equal(runs, 1);

  h.hide();
  assert.equal(h.scheduler.paused, true, 'visibilitychange pauses the scheduler');

  // A hidden tab must poll NOTHING, however long it sits there.
  h.advance(10 * 60_000);
  h.scheduler.tick();
  h.scheduler.tick();
  h.scheduler.tick();
  await settle();
  assert.equal(runs, 1, 'no requests leave the browser while hidden');

  h.show();
  await settle();
  assert.equal(h.scheduler.paused, false);
  assert.equal(runs, 2, 'resuming catches up exactly once, not once per missed tick');
});

test('a failing task backs off exponentially instead of hammering', async () => {
  const h = harness({ backoffBaseMs: 5_000 });
  let attempts = 0;
  h.scheduler.add('flaky', {
    intervalMs: 1_000,
    update: async () => {
      attempts += 1;
      throw new Error('connector down');
    },
  });
  h.scheduler.start();

  h.scheduler.tick();
  await settle();
  assert.equal(attempts, 1);

  // Interval says due, backoff says no.
  h.advance(1_000);
  h.scheduler.tick();
  await settle();
  assert.equal(attempts, 1, 'still inside the first backoff window');

  h.advance(4_000); // now 5s since the failure
  h.scheduler.tick();
  await settle();
  assert.equal(attempts, 2, 'retries once the backoff has elapsed');

  // Second consecutive failure doubles the wait to 10s.
  h.advance(5_000);
  h.scheduler.tick();
  await settle();
  assert.equal(attempts, 2, 'backoff widened after the second failure');

  h.advance(5_000);
  h.scheduler.tick();
  await settle();
  assert.equal(attempts, 3);
});

test('backoff is capped and resets after a success', async () => {
  const h = harness({ backoffBaseMs: 5_000, backoffMaxMs: 20_000 });
  assert.equal(h.scheduler.backoffFor(1), 5_000);
  assert.equal(h.scheduler.backoffFor(2), 10_000);
  assert.equal(h.scheduler.backoffFor(3), 20_000);
  assert.equal(h.scheduler.backoffFor(9), 20_000, 'never exceeds the cap');

  let fail = true;
  h.scheduler.add('w', {
    intervalMs: 1_000,
    update: async () => {
      if (fail) throw new Error('down');
    },
  });
  h.scheduler.start();

  h.scheduler.tick();
  await settle();
  assert.equal(h.scheduler.inspect('w').failures, 1);

  fail = false;
  h.advance(5_000);
  h.scheduler.tick();
  await settle();
  assert.equal(h.scheduler.inspect('w').failures, 0, 'a success clears the backoff');
  assert.equal(h.scheduler.inspect('w').retryAfter, null);
});

test('requiresUpdate is asked before update runs', async () => {
  const h = harness();
  let runs = 0;
  let allow = false;
  h.scheduler.add('w', {
    intervalMs: 1_000,
    requiresUpdate: () => allow,
    update: async () => void runs++,
  });
  h.scheduler.start();

  h.scheduler.tick();
  await settle();
  assert.equal(runs, 0, 'the host asks first, and the widget declined');

  allow = true;
  h.scheduler.tick();
  await settle();
  assert.equal(runs, 1);
});

test('a widget with no refresh interval is never polled', async () => {
  const h = harness();
  let runs = 0;
  h.scheduler.add('static', { intervalMs: null, update: async () => void runs++ });
  h.scheduler.start();

  h.advance(60 * 60_000);
  h.scheduler.tick();
  await settle();
  assert.equal(runs, 0);
});
