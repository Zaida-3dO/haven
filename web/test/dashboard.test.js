import test from 'node:test';
import assert from 'node:assert/strict';

import { Dashboard } from '../src/shell/dashboard.js';
import { WidgetRegistry } from '../src/shell/registry.js';
import { Fetcher } from '../src/shell/fetcher.js';
import { Scheduler } from '../src/shell/scheduler.js';
import { DONE, ERROR } from '../src/shell/panel-data.js';
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
