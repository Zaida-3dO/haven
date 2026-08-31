import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  DEFAULT_COLUMNS,
  breakpointForWidth,
  extractLayout,
  hasCachedLayout,
  nodeFromWidgetMeta,
  widgetIdFromHash,
} from '../src/shell/grid-layout.js';

/**
 * A stand-in for a GridStack instance, modelling the one behaviour that
 * actually matters here: `save(..., column)` returns the cached layout for
 * that column **only if one exists**, and otherwise falls back to the geometry
 * of whatever column is currently rendered.
 */
function fakeGrid({ column = 12, nodes = [], layouts = {} } = {}) {
  return {
    getColumn: () => column,
    engine: { _layouts: layouts },
    save(_saveContent, _saveGridOpt, _saveCB, requestedColumn) {
      if (requestedColumn && requestedColumn !== column && layouts[requestedColumn]) {
        return layouts[requestedColumn];
      }
      return nodes;
    },
  };
}

describe('breakpointForWidth', () => {
  test('the breakpoint boundary is inclusive of the mobile max width', () => {
    assert.equal(breakpointForWidth(768), 'mobile');
    assert.equal(breakpointForWidth(769), 'desktop');
    assert.equal(breakpointForWidth(320), 'mobile');
  });

  test('honours a custom breakpoint width', () => {
    assert.equal(breakpointForWidth(800, 900), 'mobile');
    assert.equal(breakpointForWidth(1000, 900), 'desktop');
  });
});

describe('nodeFromWidgetMeta', () => {
  const meta = {
    defaultSize: { w: 3, h: 2 },
    mobileSize: { w: 4, h: 3 },
    minSize: { w: 2, h: 1 },
  };

  test('uses defaultSize on desktop and mobileSize on mobile', () => {
    assert.deepEqual(nodeFromWidgetMeta(meta, 'desktop'), { w: 3, h: 2, minW: 2, minH: 1 });
    assert.deepEqual(nodeFromWidgetMeta(meta, 'mobile'), { w: 4, h: 3, minW: 2, minH: 1 });
  });

  test('falls back to defaultSize on mobile when no mobileSize is declared', () => {
    const noMobile = { defaultSize: { w: 5, h: 5 } };
    assert.deepEqual(nodeFromWidgetMeta(noMobile, 'mobile'), { w: 5, h: 5 });
  });

  test('maps minSize onto GridStack minW/minH so a widget cannot be shrunk below it', () => {
    const node = nodeFromWidgetMeta(meta, 'desktop');
    assert.equal(node.minW, 2);
    assert.equal(node.minH, 1);
  });

  test('overrides win over the size taken from metadata', () => {
    const node = nodeFromWidgetMeta(meta, 'desktop', { x: 4, y: 1, w: 6 });
    assert.equal(node.w, 6);
    assert.equal(node.x, 4);
    assert.equal(node.y, 1);
  });
});

describe('extractLayout', () => {
  test('returns the cached layout for a breakpoint that has one', () => {
    const grid = fakeGrid({
      column: 12,
      nodes: [{ id: 'a', x: 6, y: 0, w: 6, h: 2 }],
      layouts: { 4: [{ id: 'a', x: 0, y: 3, w: 4, h: 2 }] },
    });

    const mobile = extractLayout(grid, 'mobile', DEFAULT_COLUMNS);

    assert.deepEqual(mobile, [{ id: 'a', x: 0, y: 3, w: 4, h: 2 }]);
  });

  test('normalises missing coordinates rather than emitting undefined', () => {
    // GridStack legitimately produces nodes with no x/y for an
    // auto-positioned widget, and the server rejects undefined coordinates.
    const grid = fakeGrid({ column: 12, nodes: [{ id: 'a', w: 3, h: 2 }] });

    assert.deepEqual(extractLayout(grid, 'desktop', DEFAULT_COLUMNS), [
      { id: 'a', x: 0, y: 0, w: 3, h: 2 },
    ]);
  });

  test('keeps widgetId when present and omits it when absent', () => {
    const grid = fakeGrid({
      column: 12,
      nodes: [
        { id: 'a', x: 0, y: 0, w: 1, h: 1, widgetId: 'clock-1' },
        { id: 'b', x: 1, y: 0, w: 1, h: 1 },
      ],
    });

    const [withId, withoutId] = extractLayout(grid, 'desktop', DEFAULT_COLUMNS);

    assert.equal(withId.widgetId, 'clock-1');
    assert.ok(!('widgetId' in withoutId));
  });

  test('coerces a numeric node id to a string, as the server requires', () => {
    const grid = fakeGrid({ column: 12, nodes: [{ id: 7, x: 0, y: 0, w: 1, h: 1 }] });
    assert.equal(extractLayout(grid, 'desktop', DEFAULT_COLUMNS)[0].id, '7');
  });
});

describe('hasCachedLayout', () => {
  // This is the guard that stops desktop geometry being written into the
  // mobile row. Without it, saving both breakpoints from a desktop-only
  // session silently auto-reflows — the thing DESIGN §3 rejects outright.
  test('the currently rendered breakpoint always counts as arranged', () => {
    const grid = fakeGrid({ column: 12, layouts: {} });
    assert.equal(hasCachedLayout(grid, 'desktop', DEFAULT_COLUMNS), true);
  });

  test('an unvisited breakpoint with no cached layout does not count', () => {
    const grid = fakeGrid({ column: 12, layouts: {} });
    assert.equal(hasCachedLayout(grid, 'mobile', DEFAULT_COLUMNS), false);
  });

  test('a breakpoint GridStack has cached does count', () => {
    const grid = fakeGrid({ column: 12, layouts: { 4: [{ id: 'a', x: 0, y: 0, w: 4, h: 1 }] } });
    assert.equal(hasCachedLayout(grid, 'mobile', DEFAULT_COLUMNS), true);
  });
});

describe('widgetIdFromHash', () => {
  test('reads the id out of a #widget-id hash', () => {
    assert.equal(widgetIdFromHash('#clock-1'), 'clock-1');
  });

  test('decodes a percent-encoded id', () => {
    assert.equal(widgetIdFromHash('#clock%20one'), 'clock one');
  });

  test('returns null for an empty or absent hash', () => {
    assert.equal(widgetIdFromHash('#'), null);
    assert.equal(widgetIdFromHash(''), null);
    assert.equal(widgetIdFromHash(undefined), null);
  });
});
