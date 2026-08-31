import test from 'node:test';
import assert from 'node:assert/strict';

import { WidgetRegistry } from '../src/shell/registry.js';

const base = {
  type: 'clock',
  name: 'Clock',
  configSchema: [{ key: 'tz', type: 'text', default: 'UTC' }],
};

test('registration normalises the static metadata', () => {
  const registry = new WidgetRegistry();
  const def = registry.register({ ...base, defaultSize: { w: 4, h: 3 }, refreshMs: 30_000 });

  assert.equal(def.type, 'clock');
  assert.equal(def.tag, 'haven-widget-clock', 'a tag is derived when not given');
  assert.deepEqual(def.defaultSize, { w: 4, h: 3 });
  assert.deepEqual(def.minSize, { w: 1, h: 1 });
  assert.deepEqual(def.mobileSize, { w: 4, h: 3 }, 'mobileSize falls back to defaultSize');
  assert.equal(def.searchable, false);
  assert.equal(def.configVersion, 1);
});

test('a widget with no refreshMs declares null, not a default poll', () => {
  const registry = new WidgetRegistry();
  const def = registry.register(base);
  // A static widget must not occupy a slot in the schedule.
  assert.equal(def.refreshMs, null);
});

test('a duplicate type is refused', () => {
  const registry = new WidgetRegistry();
  registry.register(base);
  assert.throws(() => registry.register(base), /already registered/);
});

test('a widget without a type is refused', () => {
  const registry = new WidgetRegistry();
  assert.throws(() => registry.register({ name: 'Nameless' }), /string `type`/);
});

test('a malformed configSchema fails at registration, not at first render', () => {
  const registry = new WidgetRegistry();
  assert.throws(
    () => registry.register({ type: 'bad', configSchema: [{ key: 'x', type: 'nope' }] }),
    /unknown type/
  );
});

test('getStubConfig makes "Add widget" produce something that works', () => {
  const registry = new WidgetRegistry();
  registry.register({
    type: 'weather',
    configSchema: [
      { key: 'url', type: 'url' },
      { key: 'units', type: 'select', default: 'metric', options: [{ value: 'metric' }] },
    ],
    getStubConfig: () => ({ url: 'https://example.invalid/weather' }),
  });

  const stub = registry.stubConfig('weather');
  assert.equal(stub.url, 'https://example.invalid/weather');
  assert.equal(stub.units, 'metric', 'schema defaults fill the rest');
  assert.equal(stub.configVersion, 1, 'a stub is versioned like any other config');
});

test('a widget with no getStubConfig still yields the schema defaults', () => {
  const registry = new WidgetRegistry();
  registry.register(base);
  assert.deepEqual(registry.stubConfig('clock'), { tz: 'UTC', configVersion: 1 });
});

test('stubConfig on an unknown type is an error', () => {
  const registry = new WidgetRegistry();
  assert.throws(() => registry.stubConfig('ghost'), /unknown widget type/);
});

test('the catalogue lists what the Add-widget panel needs', () => {
  const registry = new WidgetRegistry();
  registry.register(base);
  registry.register({ type: 'weather', name: 'Weather', configSchema: [] });

  const catalogue = registry.catalogue();
  assert.deepEqual(
    catalogue.map((c) => c.type),
    ['clock', 'weather']
  );
  assert.ok(catalogue.every((c) => c.defaultSize && c.minSize));
});

test('an unregistered type reads as absent rather than throwing', () => {
  const registry = new WidgetRegistry();
  assert.equal(registry.get('ghost'), null);
  assert.equal(registry.has('ghost'), false);
});
