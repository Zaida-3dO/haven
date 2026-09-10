/**
 * GridStack mount, per-breakpoint layout glue, the iframe pointer shim and
 * `#widget-id` deep links.
 *
 * The pieces here that are not obvious are all documented in DESIGN §3, and
 * each exists because of a specific failure mode:
 *
 *  - **The iframe pointer shim.** Dragging over an iframe stops mid-drag
 *    because the iframe is a separate document that swallows the mouse
 *    events. No grid library solves this (GridStack #1660, #2915) — it is
 *    inherent to iframes. Grafana's fix, and ours: disable pointer events on
 *    every widget iframe for the duration of a drag or resize.
 *  - **Per-breakpoint extraction.** GridStack caches per-column layouts in
 *    memory but does not include them in `save()`. `save()` takes a `column`
 *    argument for exactly this, but see `extractLayout` for the sharp edge in
 *    how it behaves when no cached layout exists.
 *  - **No auto-reflow.** Desktop and mobile are arranged separately and
 *    neither is derived from the other. DESIGN §3 rejects auto-collapse
 *    outright, so there is deliberately no code path here that writes one
 *    breakpoint's geometry into the other.
 */

import { GridStack } from 'gridstack';

import { BREAKPOINTS } from './layout-client.js';
import {
  DEEP_LINK_HIGHLIGHT_MS,
  DEFAULT_COLUMNS,
  DEFAULT_MOBILE_BREAKPOINT,
  extractLayout,
  findWidgetElement,
  hasCachedLayout,
  widgetIdFromHash,
} from './grid-layout.js';

// The pure layout logic lives in `grid-layout.js` so it can be tested under
// `node --test`: GridStack's ESM uses extensionless imports that Vite resolves
// and Node does not, so any module importing it is untestable there. Re-
// exported here so callers have one import for the grid layer.
export {
  breakpointForWidth,
  extractLayout,
  findWidgetElement,
  hasCachedLayout,
  nodeFromWidgetMeta,
  widgetIdFromHash,
  DEFAULT_COLUMNS,
  DEFAULT_MOBILE_BREAKPOINT,
  DEEP_LINK_HIGHLIGHT_MS,
} from './grid-layout.js';

/**
 * Installs the iframe pointer shim on a grid.
 *
 * The fix itself is the four handlers; the rest is making sure a restore
 * always happens, because a widget left with `pointer-events: none` is an
 * iframe nobody can click again.
 *
 * @returns {() => void} teardown
 */
export function installIframePointerShim(grid, root) {
  const suppressed = new Map();

  const suppress = () => {
    for (const frame of root.querySelectorAll('iframe')) {
      // Remember what was there so a widget that sets its own value keeps it.
      if (!suppressed.has(frame)) suppressed.set(frame, frame.style.pointerEvents);
      frame.style.pointerEvents = 'none';
    }
  };

  const restore = () => {
    for (const [frame, previous] of suppressed) {
      frame.style.pointerEvents = previous || '';
    }
    suppressed.clear();
  };

  grid.on('dragstart', suppress);
  grid.on('resizestart', suppress);
  grid.on('dragstop', restore);
  grid.on('resizestop', restore);

  return () => {
    restore();
    grid.off('dragstart');
    grid.off('resizestart');
  };
}

/**
 * Scrolls to a widget and briefly highlights it.
 *
 * The highlight is what makes a deep link legible — scrolling alone leaves you
 * looking at a wall of widgets wondering which one you were sent to.
 *
 * @returns {boolean} whether the widget was found.
 */
export function focusWidget(root, widgetId, { highlightMs = DEEP_LINK_HIGHLIGHT_MS } = {}) {
  if (!widgetId) return false;

  const el = findWidgetElement(root, widgetId);
  if (!el) return false;

  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('haven-widget--deep-linked');
  globalThis.setTimeout(() => el.classList.remove('haven-widget--deep-linked'), highlightMs);

  return true;
}

/**
 * Mounts GridStack and returns the handle the rest of the shell drives.
 *
 * The grid starts in **view mode**: dragging and resizing are off until edit
 * mode is entered (DESIGN §7). Always-on dragging means accidental drags every
 * time you try to click a torrent or scroll a calendar.
 */
export function mountGrid({
  root,
  columns = DEFAULT_COLUMNS,
  mobileMaxWidth = DEFAULT_MOBILE_BREAKPOINT,
  cellHeight = 90,
  // 0, deliberately — the spacing between widgets is padding INSIDE the tile,
  // not margin around it. See `--haven-widget-inset` in main.css for why.
  margin = 0,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  gridstack = GridStack,
} = {}) {
  if (!root) throw new Error('mountGrid: no root element');

  const mobileQuery = matchMedia?.(`(max-width: ${mobileMaxWidth}px)`);
  const currentBreakpoint = () => (mobileQuery?.matches ? 'mobile' : 'desktop');

  const grid = gridstack.init(
    {
      column: columns[currentBreakpoint()],
      cellHeight,
      margin,
      // View mode is the default and it does not move (DESIGN §7).
      disableDrag: true,
      disableResize: true,
      // Only the header is a drag handle, so text inside a widget stays
      // selectable and its buttons stay clickable in edit mode.
      handle: '.haven-widget__handle',
      float: false,
    },
    root
  );

  const teardownShim = installIframePointerShim(grid, root);
  const resizeListeners = new Set();
  const layoutChangeListeners = new Set();

  /**
   * GridStack's `change` fires whenever node geometry actually changes — the
   * end of a drag, the end of a resize, or a programmatic `update()`. It is
   * the seam the toolbar needs to re-evaluate whether there is anything to
   * save; without it, the Save button's state is computed once on entering
   * edit mode and never again, so it cannot notice the first drag.
   *
   * Deliberately NOT `dragstop`/`resizestop`: those fire even when a tile is
   * dropped exactly where it started, and `change` does not.
   */
  grid.on('change', () => {
    for (const listener of layoutChangeListeners) listener();
  });

  /**
   * Switches the rendered column count to match a breakpoint.
   *
   * Defined before the handle so the media-query subscription below can share
   * it with the exported `setBreakpoint` — one implementation, so a viewport
   * change and a programmatic call cannot drift apart.
   */
  const applyBreakpoint = (breakpoint) => {
    const column = columns[breakpoint];
    if (column && grid.getColumn() !== column) grid.column(column);
  };

  /**
   * Re-column the grid when the viewport crosses the breakpoint.
   *
   * **Why this listener is the whole fix.** `column` is read once, above, when
   * GridStack is initialised. `currentBreakpoint()` is a live closure over the
   * media query, so it starts reporting `mobile` the instant the window
   * narrows — but nothing consumed that, so the grid stayed at whatever column
   * count it was built with. A dashboard loaded wide and then narrowed (a
   * desktop window being resized, or a phone rotating from landscape to
   * portrait) kept its 12 columns at 390px, which renders a 2-column tile
   * about 37px wide: too narrow to show anything.
   *
   * Loading directly at 390px always worked, because init read the query at
   * the moment it already matched. That asymmetry is exactly why the browser
   * suite missed this — Playwright applies its viewport before `goto`, so the
   * fresh-load path was the only one it could reach.
   *
   * `change` on the MediaQueryList rather than `resize` on the window: it
   * fires only when the boundary is actually crossed, instead of on every
   * pixel of a drag, so there is no need to debounce a `grid.column()` call
   * that relays out every tile.
   */
  const onBreakpointChange = () => applyBreakpoint(currentBreakpoint());

  // `addEventListener` is the modern API; `addListener` is the deprecated one
  // kept for older Safari. Feature-detected rather than assumed, because the
  // injected fake in the unit suite implements neither and must not throw.
  if (typeof mobileQuery?.addEventListener === 'function') {
    mobileQuery.addEventListener('change', onBreakpointChange);
  } else if (typeof mobileQuery?.addListener === 'function') {
    mobileQuery.addListener(onBreakpointChange);
  }

  const teardownBreakpoint = () => {
    if (typeof mobileQuery?.removeEventListener === 'function') {
      mobileQuery.removeEventListener('change', onBreakpointChange);
    } else if (typeof mobileQuery?.removeListener === 'function') {
      mobileQuery.removeListener(onBreakpointChange);
    }
  };

  // `resizestop` carries the final geometry — this is what a WebGL widget
  // hooks to call renderer.setSize(). Firing on every `resize` tick instead
  // would thrash a 3D scene for the whole duration of the drag.
  grid.on('resizestop', (event, el) => {
    const node = el?.gridstackNode;
    if (!node) return;
    for (const listener of resizeListeners) listener(String(node.id), node.w, node.h, el);
  });

  return {
    grid,
    root,
    columns,

    breakpoint: currentBreakpoint,

    /** Registers a listener for `resizestop`. @returns {() => void} unsubscribe */
    onWidgetResize(listener) {
      resizeListeners.add(listener);
      return () => resizeListeners.delete(listener);
    },

    /**
     * Registers a listener for any change to node geometry.
     *
     * @returns {() => void} unsubscribe
     */
    onLayoutChange(listener) {
      layoutChangeListeners.add(listener);
      return () => layoutChangeListeners.delete(listener);
    },

    /** Enables/disables dragging + resizing wholesale — the edit-mode switch. */
    setEditable(editable) {
      grid.enableMove(editable);
      grid.enableResize(editable);
      root.classList.toggle('haven-grid--editing', editable);
    },

    /** Applies a saved layout to the live grid without touching widget content. */
    applyLayout(nodes) {
      if (!Array.isArray(nodes) || nodes.length === 0) return;
      grid.batchUpdate();
      try {
        for (const node of nodes) {
          // Same lookup as the deep link, and for the same reason: GridStack
          // eats the `gs-id` attribute once it adopts an element.
          const el = findWidgetElement(root, String(node.id));
          if (el) grid.update(el, { x: node.x, y: node.y, w: node.w, h: node.h });
        }
      } finally {
        grid.batchUpdate(false);
      }
    },

    /**
     * Switches rendered column count. GridStack caches the layout it leaves.
     *
     * Shares `applyBreakpoint` with the media-query subscription above, so
     * driving the grid by hand and the viewport driving it cannot diverge.
     */
    setBreakpoint(breakpoint) {
      applyBreakpoint(breakpoint);
    },

    extract: (breakpoint) => extractLayout(grid, breakpoint, columns),
    hasLayoutFor: (breakpoint) => hasCachedLayout(grid, breakpoint, columns),
    focus: (widgetId, opts) => focusWidget(root, widgetId, opts),

    destroy() {
      teardownShim();
      teardownBreakpoint();
      resizeListeners.clear();
      layoutChangeListeners.clear();
      grid.destroy(false);
    },
  };
}

/**
 * Wires `#widget-id` deep links, including the one already in the URL at load.
 *
 * @returns {() => void} teardown
 */
export function installDeepLinks(gridHandle, { target = globalThis } = {}) {
  const go = () => {
    const id = widgetIdFromHash(target.location?.hash);
    if (id) gridHandle.focus(id);
  };

  target.addEventListener('hashchange', go);
  go();

  return () => target.removeEventListener('hashchange', go);
}

export { BREAKPOINTS };
