import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { CLOCK_TICK_MS, startClockTicks } from '../src/shell/clock-source.js';
import { Scheduler } from '../src/shell/scheduler.js';

/** A host double recording the payloads pushed into it. */
function fakeHost(id = 'clock-1') {
  const received = [];
  return { id, received, onData: (data) => received.push(data) };
}

/** A scheduler driven by hand rather than by wall-clock time. */
function controlledScheduler(startAt = 0) {
  let now = startAt;
  const scheduler = new Scheduler({
    now: () => now,
    // The scheduler's own timer is never started; tests call tick() directly.
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    visibility: { isHidden: () => false, subscribe() {}, unsubscribe() {} },
  });
  scheduler.start();

  return {
    scheduler,
    advance(ms) {
      now += ms;
      scheduler.tick();
    },
  };
}

describe('startClockTicks', () => {
  test('paints immediately rather than leaving a placeholder for a second', () => {
    const host = fakeHost();
    const { scheduler } = controlledScheduler();

    startClockTicks({ scheduler, host, now: () => 1_000 });

    assert.equal(host.received.length, 1);
    assert.equal(host.received[0].value.timestamp, 1_000);
  });

  test('registers exactly one task on the shared scheduler', () => {
    // The point of the whole arrangement: one timer in the page, owned by the
    // host, no matter how many clocks are on the dashboard.
    const { scheduler } = controlledScheduler();

    startClockTicks({ scheduler, host: fakeHost('a'), now: () => 0 });
    startClockTicks({ scheduler, host: fakeHost('b'), now: () => 0 });

    assert.equal(scheduler.size, 2);
  });

  test('pushes a new payload once the tick interval has elapsed', () => {
    const host = fakeHost();
    const controller = controlledScheduler();
    let clock = 1_000;

    startClockTicks({ scheduler: controller.scheduler, host, now: () => clock });
    clock += CLOCK_TICK_MS;
    controller.advance(CLOCK_TICK_MS);

    assert.equal(host.received.length, 2);
    assert.equal(host.received[1].value.timestamp, 1_000 + CLOCK_TICK_MS);
  });

  test('bumps the revision when the second changes, so the widget redraws', () => {
    // The host skips onData when the revision is unchanged, so a clock that
    // did not bump it would visibly freeze.
    const host = fakeHost();
    const controller = controlledScheduler();
    let clock = 1_000;

    startClockTicks({ scheduler: controller.scheduler, host, now: () => clock });
    clock += CLOCK_TICK_MS;
    controller.advance(CLOCK_TICK_MS);

    assert.ok(host.received[1].revision > host.received[0].revision);
  });

  test('does not bump the revision when the timestamp has not moved', () => {
    // Same value, same revision — this is what keeps "never re-render on every
    // data tick" true, and is what protects a canvas from being blown away.
    const host = fakeHost();
    const controller = controlledScheduler();

    startClockTicks({ scheduler: controller.scheduler, host, now: () => 1_000 });
    controller.advance(CLOCK_TICK_MS);

    assert.equal(host.received.length, 2);
    assert.equal(host.received[1].revision, host.received[0].revision);
  });

  test('pushes a done payload, never an error one', () => {
    const host = fakeHost();
    const { scheduler } = controlledScheduler();

    startClockTicks({ scheduler, host, now: () => 1_000 });

    assert.equal(host.received[0].state, 'done');
    assert.deepEqual(host.received[0].errors, []);
  });

  test('teardown removes the task, so a removed clock stops ticking', () => {
    const host = fakeHost();
    const controller = controlledScheduler();

    const stop = startClockTicks({ scheduler: controller.scheduler, host, now: () => 1_000 });
    stop();
    controller.advance(CLOCK_TICK_MS * 5);

    assert.equal(controller.scheduler.size, 0);
    assert.equal(host.received.length, 1, 'only the initial paint');
  });

  test('stops pushing while the tab is hidden', async () => {
    // A hidden tab must do no work. The scheduler owns this, but the clock
    // task has to actually be subject to it — which it is only because it is
    // registered there rather than running its own interval.
    const host = fakeHost();
    let now = 1_000;
    let hidden = false;

    const scheduler = new Scheduler({
      now: () => now,
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
      visibility: { isHidden: () => hidden, subscribe() {}, unsubscribe() {} },
    });
    scheduler.start();
    startClockTicks({ scheduler, host, now: () => now });

    const afterFirstPaint = host.received.length;

    hidden = true;
    scheduler.pause();
    now += CLOCK_TICK_MS * 10;
    scheduler.tick();

    assert.equal(host.received.length, afterFirstPaint, 'no ticks while hidden');
  });
});
