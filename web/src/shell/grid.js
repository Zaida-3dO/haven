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

/** Column counts per breakpoint, matching `config/settings.example.json`. */
export const DEFAULT_COLUMNS = Object.freeze({ desktop: 12, mobile: 4 });

/** Viewport width at or below which the mobile breakpoint applies. */
export const DEFAULT_MOBILE_BREAKPOINT = 768;

/** How long a deep-linked widget stays highlighted. */
export const DEEP_LINK_HIGHLIGHT_MS = 2000;

/**
 * Which breakpoint a viewport width belongs to.
 *
 * Exported because both the grid and the edit-mode UI need to agree on it —
 * edit mode must save the breakpoint the user is actually looking at.
 */
export function breakpointForWidth(width, mobileMaxWidth = DEFAULT_MOBILE_BREAKPOINT) {
  return width <= mobileMaxWidth ? 'mobile' : 'desktop';
}

/**
 * Builds a GridStack node from a widget's static metadata.
 *
 * `minSize` maps to GridStack's `minW`/`minH`, which is what stops a widget
 * being resized below the size it can actually render at. `mobileSize` is used
 * in preference to `defaultSize` on the mobile breakpoint, per the contract.
 */
export function nodeFromWidgetMeta(meta, breakpoint, overrides = {}) {
  const size =
    breakpoint === 'mobile' && meta?.mobileSize ? meta.mobileSize : (meta?.defaultSize ?? {});

  const node = {
    w: size.w ?? 2,
    h: size.h ?? 2,
    ...overrides,
  };

  if (meta?.minSize?.w !== undefined) node.minW = meta.minSize.w;
  if (meta?.minSize?.h !== undefined) node.minH = meta.minSize.h;

  return node;
}

/**
 * Extracts one breakpoint's layout from a live grid.
 *
 * **The sharp edge:** `save(..., column)` substitutes GridStack's cached
 * layout for that column *only if one exists*. If the user has never been at
 * that breakpoint there is no cached layout, and GridStack returns the
 * geometry of the column currently rendered instead. Writing that to the other
 * breakpoint would silently reflow desktop into mobile — the exact thing
 * DESIGN §3 rejects — so callers must not persist a breakpoint that was never
 * arranged. {@link hasCachedLayout} is how you tell.
 *
 * @returns {Array<object>} normalised nodes, geometry only.
 */
export function extractLayout(grid, breakpoint, columns = DEFAULT_COLUMNS) {
  const column = columns[breakpoint];
  const saved = grid.save(false, false, undefined, column);
  const nodes = Array.isArray(saved) ? saved : (saved?.children ?? []);

  return nodes.map((n) => ({
    id: String(n.id),
    x: n.x ?? 0,
    y: n.y ?? 0,
    w: n.w ?? 1,
    h: n.h ?? 1,
    ...(n.widgetId !== undefined ? { widgetId: n.widgetId } : {}),
  }));
}

/**
 * Whether GridStack holds a layout for a breakpoint's column count — i.e.
 * whether that breakpoint has ever actually been arranged.
 *
 * The currently-rendered column always counts: its layout is live, not cached.
 */
export function hasCachedLayout(grid, breakpoint, columns = DEFAULT_COLUMNS) {
  const column = columns[breakpoint];
  if (grid.getColumn() === column) return true;
  return Boolean(grid.engine?._layouts?.[column]);
}

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

  const el = root.querySelector(`[gs-id="${CSS.escape(widgetId)}"]`);
  if (!el) return false;

  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('haven-widget--deep-linked');
  globalThis.setTimeout(() => el.classList.remove('haven-widget--deep-linked'), highlightMs);

  return true;
}

/** Reads a widget id out of a `#widget-id` style hash. */
export function widgetIdFromHash(hash) {
  if (typeof hash !== 'string') return null;
  const id = hash.replace(/^#/, '').trim();
  return id === '' ? null : decodeURIComponent(id);
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
  margin = 8,
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
          const el = root.querySelector(`[gs-id="${CSS.escape(String(node.id))}"]`);
          if (el) grid.update(el, { x: node.x, y: node.y, w: node.w, h: node.h });
        }
      } finally {
        grid.batchUpdate(false);
      }
    },

    /** Switches rendered column count. GridStack caches the layout it leaves. */
    setBreakpoint(breakpoint) {
      const column = columns[breakpoint];
      if (column && grid.getColumn() !== column) grid.column(column);
    },

    extract: (breakpoint) => extractLayout(grid, breakpoint, columns),
    hasLayoutFor: (breakpoint) => hasCachedLayout(grid, breakpoint, columns),
    focus: (widgetId, opts) => focusWidget(root, widgetId, opts),

    destroy() {
      teardownShim();
      resizeListeners.clear();
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
