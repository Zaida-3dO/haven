/**
 * The wiring between the dashboard and the search index: widgets push their
 * entries in on data change, and a removed widget takes its entries with it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Dashboard } from '../src/shell/dashboard.js';
import { WidgetRegistry } from '../src/shell/registry.js';
import { Fetcher } from '../src/shell/fetcher.js';
import { Scheduler } from '../src/shell/scheduler.js';
import { createFakeDocument, createCustomElements, FakeElement } from './helpers/fake-dom.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A widget whose search entries come from whatever data it was last given. */
function makeEventWidget() {
  const el = new FakeElement('haven-widget-events');
  el.setConfig = (c) => void (el.config = c);
  el.onData = (d) => void (el.data = d);
  el.render = () => {};
  el.getSearchEntries = () =>
    (el.data?.value?.events ?? []).map((title, i) => ({ id: `e${i}`, title }));
  return el;
}

function withFakeDom(run) {
  const customElements = createCustomElements();
  const factory = () => makeEventWidget();
  const document = createFakeDocument(new Map([['haven-widget-events', factory]]));
  customElements.define('haven-widget-events', factory);

  const prevDoc = globalThis.document;
  const prevCe = globalThis.customElements;
  globalThis.document = document;
  globalThis.customElements = customElements;
  try {
    return run({ container: new FakeElement('div') });
  } finally {
    globalThis.document = prevDoc;
    globalThis.customElements = prevCe;
  }
}

function eventsRegistry() {
  const registry = new WidgetRegistry();
  registry.register({
    type: 'events',
    name: 'Calendar',
    tag: 'haven-widget-events',
    refreshMs: 30_000,
    searchable: true,
    configSchema: [{ key: 'url', type: 'url', required: true }],
    dataSource: (config) => ({ url: config.url }),
  });
  return registry;
}

function dashboardWith(transport, container) {
  return new Dashboard({
    registry: eventsRegistry(),
    fetcher: new Fetcher({ transport, cacheMs: 0 }),
    scheduler: new Scheduler({ setIntervalFn: () => 1, clearIntervalFn: () => {} }),
    container,
  });
}

test('a widget receiving data pushes its entries into the index', async () => {
  await withFakeDom(async ({ container }) => {
    const dashboard = dashboardWith(async () => ({ events: ['Reading group'] }), container);
    dashboard.add({ id: 'cal-1', type: 'events', config: { url: 'https://x.example.invalid/' } });

    await settle();
    await settle();

    assert.equal(dashboard.searchIndex.size, 1);
    const [hit] = dashboard.searchIndex.search('reading');
    assert.equal(hit.title, 'Reading group');
    // Results group under the widget's registry name.
    assert.equal(dashboard.searchIndex.label('cal-1'), 'Calendar');
  });
});

test('a refresh replaces the widget entries instead of growing the index', async () => {
  await withFakeDom(async ({ container }) => {
    let events = ['Reading group', 'Dentist'];
    const dashboard = dashboardWith(async () => ({ events }), container);
    dashboard.add({ id: 'cal-1', type: 'events', config: { url: 'https://x.example.invalid/' } });

    await settle();
    await settle();
    assert.equal(dashboard.searchIndex.size, 2);

    // Three more 30s ticks with the same data must not triple the index.
    for (let i = 0; i < 3; i += 1) {
      await dashboard.refresh('cal-1');
      await settle();
    }
    assert.equal(dashboard.searchIndex.size, 2, 'refreshes must not accumulate');

    // And when the data actually changes, the old entry stops being findable.
    events = ['Standup'];
    await dashboard.refresh('cal-1');
    await settle();

    assert.equal(dashboard.searchIndex.size, 1);
    assert.deepEqual(dashboard.searchIndex.search('dentist'), []);
  });
});

test('removing a widget removes its entries from the index', async () => {
  await withFakeDom(async ({ container }) => {
    const dashboard = dashboardWith(async () => ({ events: ['Reading group'] }), container);
    dashboard.add({ id: 'cal-1', type: 'events', config: { url: 'https://x.example.invalid/' } });

    await settle();
    await settle();
    assert.equal(dashboard.searchIndex.size, 1);

    dashboard.remove('cal-1');
    assert.equal(dashboard.searchIndex.size, 0);
    assert.deepEqual(dashboard.searchIndex.search('reading'), []);
  });
});

test('destroying the dashboard empties the index — nothing outlives the session', async () => {
  await withFakeDom(async ({ container }) => {
    const dashboard = dashboardWith(async () => ({ events: ['Reading group'] }), container);
    dashboard.add({ id: 'cal-1', type: 'events', config: { url: 'https://x.example.invalid/' } });

    await settle();
    await settle();
    assert.equal(dashboard.searchIndex.size, 1);

    dashboard.destroy();
    assert.equal(dashboard.searchIndex.size, 0);
  });
});

test('reindexSearch rebuilds from the live hosts', async () => {
  await withFakeDom(async ({ container }) => {
    const dashboard = dashboardWith(async () => ({ events: ['Reading group'] }), container);
    dashboard.add({ id: 'cal-1', type: 'events', config: { url: 'https://x.example.invalid/' } });

    await settle();
    await settle();

    dashboard.searchIndex.clear();
    assert.equal(dashboard.searchIndex.size, 0);

    assert.equal(dashboard.reindexSearch(), 1);
    assert.equal(dashboard.searchIndex.search('reading')[0].title, 'Reading group');
  });
});
