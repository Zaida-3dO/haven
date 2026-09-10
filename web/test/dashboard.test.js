import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { Dashboard } from '../src/shell/dashboard.js';
import { WidgetRegistry } from '../src/shell/registry.js';
import { Fetcher } from '../src/shell/fetcher.js';
import { Scheduler } from '../src/shell/scheduler.js';
import { DONE, ERROR } from '../src/shell/panel-data.js';
import { startClockTicks } from '../src/shell/clock-source.js';
import { createFakeDocument, createCustomElements, FakeElement } from './helpers/fake-dom.js';

// Let queued microtasks and resolved promises drain before asserting.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeWidget() {
  const el = new FakeElement('haven-widget-feed');
  el.received = [];
  el.setConfig = (c) => void (el.config = c);
  el.onData = (d) => el.received.push(d);
  el.render = () => {};
  return el;
}

/**
 * The dashboard builds hosts with the real global document, so these tests
 * install the fake DOM globally for the duration.
 */
function withFakeDom(run) {
  const customElements = createCustomElements();
  const widgets = [];
  const factory = () => {
    const w = makeWidget();
    widgets.push(w);
    return w;
  };
  const document = createFakeDocument(new Map([['haven-widget-feed', factory]]));
  customElements.define('haven-widget-feed', factory);

  const prevDoc = globalThis.document;
  const prevCe = globalThis.customElements;
  globalThis.document = document;
  globalThis.customElements = customElements;
  try {
    return run({ widgets, container: new FakeElement('div') });
  } finally {
    globalThis.document = prevDoc;
    globalThis.customElements = prevCe;
  }
}

function feedRegistry(dataSource) {
  const registry = new WidgetRegistry();
  registry.register({
    type: 'feed',
    name: 'Feed',
    tag: 'haven-widget-feed',
    refreshMs: 60_000,
    configSchema: [{ key: 'url', type: 'url', required: true }],
    dataSource,
  });
  return registry;
}

test('two widgets on one endpoint produce a single request through the dashboard', async () => {
  let calls = 0;
  const registry = feedRegistry((config) => ({ url: config.url }));
  const fetcher = new Fetcher({
    transport: async () => {
      calls += 1;
      return { items: ['a'] };
    },
    cacheMs: 60_000,
  });

  await withFakeDom(async ({ container }) => {
    const dashboard = new Dashboard({
      registry,
      fetcher,
      scheduler: new Scheduler({ setIntervalFn: () => 1, clearIntervalFn: () => {} }),
      container,
    });

    dashboard.add({ id: 'a', type: 'feed', config: { url: 'https://example.invalid/feed' } });
    dashboard.add({ id: 'b', type: 'feed', config: { url: 'https://example.invalid/feed' } });

    await settle();
    await settle();

    assert.equal(calls, 1, 'both widgets shared one request');
    assert.equal(dashboard.data('a').state, DONE);
    assert.equal(dashboard.data('b').state, DONE);
    dashboard.destroy();
  });
});

test('a failed fetch gives the widget an error payload and lets the scheduler back off', async () => {
  const registry = feedRegistry((config) => ({ url: config.url }));
  const fetcher = new Fetcher({
    transport: async () => {
      throw new Error('connector down');
    },
  });

  await withFakeDom(async ({ container }) => {
    const dashboard = new Dashboard({
      registry,
      fetcher,
      scheduler: new Scheduler({ setIntervalFn: () => 1, clearIntervalFn: () => {} }),
      container,
    });

    dashboard.add({ id: 'a', type: 'feed', config: { url: 'https://example.invalid/feed' } });
    await settle();
    await settle();

    assert.equal(dashboard.data('a').state, ERROR);
    // The scheduler recorded the failure, which is what drives the backoff.
    assert.equal(dashboard.scheduler.inspect('a').failures, 1);
    dashboard.destroy();
  });
});

test('a layout entry for an unknown widget type does not break the dashboard', async () => {
  const registry = feedRegistry((config) => ({ url: config.url }));
  const fetcher = new Fetcher({ transport: async () => ({ items: [] }) });

  await withFakeDom(async ({ container }) => {
    const dashboard = new Dashboard({
      registry,
      fetcher,
      scheduler: new Scheduler({ setIntervalFn: () => 1, clearIntervalFn: () => {} }),
      container,
    });

    // A widget removed from this build must not stop the rest loading.
    const missing = dashboard.add({ id: 'gone', type: 'removed-widget', config: {} });
    assert.equal(missing, null);

    const ok = dashboard.add({
      id: 'a',
      type: 'feed',
      config: { url: 'https://example.invalid/feed' },
    });
    assert.ok(ok);
    await settle();
    await settle();
    assert.equal(dashboard.data('a').state, DONE);
    dashboard.destroy();
  });
});

test('removing a widget also removes its scheduled task', async () => {
  const registry = feedRegistry((config) => ({ url: config.url }));
  const fetcher = new Fetcher({ transport: async () => ({ items: [] }) });

  await withFakeDom(async ({ container }) => {
    const scheduler = new Scheduler({ setIntervalFn: () => 1, clearIntervalFn: () => {} });
    const dashboard = new Dashboard({ registry, fetcher, scheduler, container });

    dashboard.add({ id: 'a', type: 'feed', config: { url: 'https://example.invalid/feed' } });
    await settle();
    assert.equal(scheduler.has('a'), true);

    dashboard.remove('a');
    // No orphaned timer: a destroyed widget must stop being polled.
    assert.equal(scheduler.has('a'), false);
    assert.equal(dashboard.data('a'), null);
    dashboard.destroy();
  });
});

// ── host-owned side tasks (the clock tick) ───────────────────────────────
//
// `startClockTicks` registers as `clock-tick:<id>` — namespaced deliberately,
// because the dashboard already registers a task under the bare `host.id` and
// `Scheduler.add` is a `Map.set`, so reusing the id would overwrite it. The
// consequence is that `remove(id)` cannot cancel the tick by id, and both
// boot.js call sites discarded the teardown it returns. Every clock add/remove
// therefore left a permanent 1 Hz task pushing into a destroyed host.

test('a registered teardown runs when its widget is removed', async () => {
  const registry = feedRegistry(null);
  await withFakeDom(async ({ container }) => {
    const scheduler = new Scheduler({ setIntervalFn: () => 1, clearIntervalFn: () => {} });
    const dashboard = new Dashboard({ registry, scheduler, container });

    dashboard.add({ id: 'a', type: 'feed', config: {} });
    let torn = 0;
    dashboard.onRemove('a', () => torn++);

    assert.equal(torn, 0, 'not until removal');
    dashboard.remove('a');
    assert.equal(torn, 1);

    // Not re-run on a second removal.
    dashboard.remove('a');
    assert.equal(torn, 1);
    dashboard.destroy();
  });
});

test('removing a clock cancels its tick task, not just its widget task', async () => {
  // The regression itself, driven through the real startClockTicks.
  const registry = feedRegistry(null);
  await withFakeDom(async ({ container }) => {
    const scheduler = new Scheduler({ setIntervalFn: () => 1, clearIntervalFn: () => {} });
    const dashboard = new Dashboard({ registry, scheduler, container });

    const host = dashboard.add({ id: 'clock-1', type: 'feed', config: {} });
    dashboard.onRemove('clock-1', startClockTicks({ scheduler: dashboard.scheduler, host }));

    assert.equal(scheduler.has('clock-tick:clock-1'), true, 'the tick registers');

    dashboard.remove('clock-1');

    // Both ids must be gone. Before the teardown was kept, the namespaced one
    // survived every removal and kept firing at 1 Hz forever.
    assert.equal(scheduler.has('clock-1'), false);
    assert.equal(scheduler.has('clock-tick:clock-1'), false, 'the tick task leaked');
    assert.equal(scheduler.size, 0, 'no task may outlive the widget that owns it');
    dashboard.destroy();
  });
});

test('a teardown runs before the host is destroyed', async () => {
  // Ordering matters: a tick that fired in between would push into a
  // destroyed host.
  const registry = feedRegistry(null);
  await withFakeDom(async ({ container }) => {
    const scheduler = new Scheduler({ setIntervalFn: () => 1, clearIntervalFn: () => {} });
    const dashboard = new Dashboard({ registry, scheduler, container });

    const host = dashboard.add({ id: 'a', type: 'feed', config: {} });
    const order = [];
    const realDestroy = host.destroy.bind(host);
    host.destroy = () => {
      order.push('host.destroy');
      realDestroy();
    };
    dashboard.onRemove('a', () => order.push('teardown'));

    dashboard.remove('a');

    assert.deepEqual(order, ['teardown', 'host.destroy']);
    dashboard.destroy();
  });
});

test('two clocks tear down independently', async () => {
  const registry = feedRegistry(null);
  await withFakeDom(async ({ container }) => {
    const scheduler = new Scheduler({ setIntervalFn: () => 1, clearIntervalFn: () => {} });
    const dashboard = new Dashboard({ registry, scheduler, container });

    for (const id of ['clock-1', 'clock-2']) {
      const host = dashboard.add({ id, type: 'feed', config: {} });
      dashboard.onRemove(id, startClockTicks({ scheduler: dashboard.scheduler, host }));
    }

    dashboard.remove('clock-1');

    assert.equal(scheduler.has('clock-tick:clock-1'), false);
    assert.equal(scheduler.has('clock-tick:clock-2'), true, 'the survivor keeps ticking');
    dashboard.destroy();
  });
});

test('a throwing teardown does not abort the rest of removal', async () => {
  const registry = feedRegistry(null);
  await withFakeDom(async ({ container }) => {
    const scheduler = new Scheduler({ setIntervalFn: () => 1, clearIntervalFn: () => {} });
    const dashboard = new Dashboard({ registry, scheduler, container });

    dashboard.add({ id: 'a', type: 'feed', config: {} });
    dashboard.onRemove('a', () => {
      throw new Error('teardown exploded');
    });

    const warn = console.warn;
    console.warn = () => {};
    try {
      dashboard.remove('a');
    } finally {
      console.warn = warn;
    }

    assert.equal(dashboard.host('a'), null, 'the widget is still removed');
    assert.equal(scheduler.has('a'), false);
    dashboard.destroy();
  });
});

test('boot.js keeps every startClockTicks teardown', () => {
  // The tests above prove the mechanism; this pins the CALLER, which is where
  // the bug actually was — `startClockTicks(...)` was invoked twice in boot.js
  // as a bare statement, discarding the teardown it returns. No test could see
  // that, because boot.js is the DOM-bound entry point and is not otherwise
  // exercised here. A source assertion is the cheap way to stop it recurring.
  const source = readFileSync(new URL('../src/shell/boot.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const calls = [...source.matchAll(/\bstartClockTicks\s*\(/g)].length;
  assert.ok(calls > 0, 'expected boot.js to still start the clock tick');

  // Every call must have its result consumed by `onRemove`, never dropped.
  const kept = [...source.matchAll(/onRemove\s*\([^)]*startClockTicks\s*\(/g)].length;
  assert.equal(
    kept,
    calls,
    `boot.js has ${calls} startClockTicks call(s) but ${kept} handed to onRemove — ` +
      'a discarded teardown leaks a 1 Hz task for every clock removed'
  );
});
