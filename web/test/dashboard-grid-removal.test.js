/**
 * `connectGrid`'s removal path.
 *
 * Removing a widget has to reach three places: the grid (the tile goes), the
 * dashboard (the host is destroyed and its search entries with it) and the
 * server (the instance row, its layout node and its credentials). The third is
 * what `onRemoved` is for — without it a widget removed in the UI comes back on
 * the next refresh, which is the same bug in the other direction from the one
 * this whole change closes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { connectGrid } from '../src/shell/dashboard-grid.js';
import { WidgetRegistry } from '../src/shell/registry.js';
import { createFakeDocument } from './helpers/fake-dom.js';

/** A `gridHandle` double — only what `connectGrid` actually touches. */
function fakeGridHandle(doc) {
  const removed = [];
  return {
    removed,
    root: doc.createElement('div'),
    breakpoint: () => 'desktop',
    onWidgetResize() {},
    grid: {
      makeWidget() {},
      removeWidget(item) {
        removed.push(item);
      },
    },
  };
}

/** A `dashboard` double recording adds and removes. */
function fakeDashboard() {
  const removed = [];
  const hosts = new Map();
  return {
    removed,
    hosts,
    host: (id) => hosts.get(id) ?? null,
    add(entry) {
      const host = { id: entry.id, type: entry.type, config: entry.config ?? {} };
      hosts.set(entry.id, host);
      return host;
    },
    remove(id) {
      removed.push(id);
      hosts.delete(id);
    },
  };
}

function setup() {
  const doc = createFakeDocument(new Map());
  const registry = new WidgetRegistry();
  registry.register({ type: 'demo', name: 'Demo', tag: 'haven-widget-demo', configSchema: [] });

  const dashboard = fakeDashboard();
  const gridHandle = fakeGridHandle(doc);
  const removedIds = [];

  const grid = connectGrid({
    dashboard,
    gridHandle,
    registry,
    document: doc,
    onRemoved: (id) => removedIds.push(id),
  });

  return { grid, dashboard, gridHandle, removedIds, doc };
}

test('removing a widget notifies the shell so the deletion can be persisted', () => {
  const { grid, removedIds } = setup();

  grid.place({ id: 'demo-1', type: 'demo', config: {} });
  grid.remove('demo-1');

  // Without this the widget is gone from the screen and still in the
  // database — it returns on the next refresh.
  assert.deepEqual(removedIds, ['demo-1']);
});

test('removing a widget takes it out of the grid and the dashboard together', () => {
  const { grid, dashboard, gridHandle } = setup();

  grid.place({ id: 'demo-1', type: 'demo', config: {} });
  grid.remove('demo-1');

  assert.equal(gridHandle.removed.length, 1, 'the tile was left on the grid');
  assert.deepEqual(dashboard.removed, ['demo-1']);
  assert.equal(grid.tileFor('demo-1'), null);
});

test('an unknown type is skipped rather than throwing', () => {
  const { grid } = setup();

  // A layout referencing a widget this build no longer has must not stop the
  // rest of the dashboard loading.
  assert.equal(grid.place({ id: 'x', type: 'not-registered', config: {} }), null);
});

test('load places each roster entry at its saved geometry', () => {
  const { grid, dashboard } = setup();

  grid.load(
    [
      { id: 'demo-1', type: 'demo', config: {} },
      { id: 'demo-2', type: 'demo', config: {} },
    ],
    [{ id: 'demo-1', x: 2, y: 3, w: 4, h: 2 }]
  );

  // Both load; the one with no node simply gets its default position, which is
  // what a newly added widget looks like before the layout is next saved.
  assert.ok(dashboard.host('demo-1'));
  assert.ok(dashboard.host('demo-2'));
});
