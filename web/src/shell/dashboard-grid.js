/**
 * Wires the grid layer to the widget host.
 *
 * `Dashboard` owns widget instances, fetching and timers; `mountGrid` owns
 * placement, dragging and breakpoints. This is the seam between them, kept in
 * its own module so neither has to know about the other.
 *
 * What it is responsible for:
 *
 *  - putting each widget's tile inside a GridStack item at its saved geometry
 *  - forwarding `resizestop` to the widget's `onResize`, which is the hook the
 *    3D widget will use for `renderer.setSize()`
 *  - inserting a widget chosen from the add panel, at its `defaultSize` with a
 *    stub config, so it works the moment it appears
 *  - removing a widget from both the grid and the dashboard together
 */

import { nodeFromWidgetMeta } from './grid-layout.js';
import { createWidgetControls } from './edit-mode.js';

/** Builds the tile wrapper: a drag handle, the widget body, and edit controls. */
function createTile({ doc, widgetId, title, onSettings, onRemove }) {
  const item = doc.createElement('div');
  item.className = 'grid-stack-item';
  item.setAttribute('gs-id', widgetId);

  const content = doc.createElement('div');
  content.className = 'grid-stack-item-content haven-widget-tile';

  // Only the header is a drag handle (`handle` in the GridStack options), so
  // text inside a widget stays selectable and its buttons stay clickable.
  const header = doc.createElement('div');
  header.className = 'haven-widget__handle';

  const heading = doc.createElement('span');
  heading.className = 'haven-widget__title';
  heading.textContent = title;
  header.appendChild(heading);

  const controls = createWidgetControls({
    widgetId,
    title,
    onSettings,
    onRemove,
    document: doc,
  });
  header.appendChild(controls.el);

  // The widget's own element is mounted in here by the host. It is the thing
  // that goes inert in edit mode, so a click selects the tile rather than
  // activating whatever is inside it.
  const body = doc.createElement('div');
  body.className = 'haven-widget__body';

  content.appendChild(header);
  content.appendChild(body);
  item.appendChild(content);

  return { item, body, controls };
}

/**
 * Connects a `Dashboard` to a mounted grid.
 *
 * @param {object} deps
 * @param {object} deps.dashboard   the widget host's Dashboard
 * @param {object} deps.gridHandle  the handle from `mountGrid`
 * @param {object} deps.registry    the widget registry
 * @param {(id: string) => void} [deps.onSettings]
 */
export function connectGrid({
  dashboard,
  gridHandle,
  registry,
  onSettings = () => {},
  document: doc = globalThis.document,
} = {}) {
  const tiles = new Map();

  // A resize is forwarded to the widget, never to a re-render of the tile —
  // `onResize` is where a WebGL widget calls renderer.setSize(), and rebuilding
  // the DOM around it would destroy the canvas it just resized.
  gridHandle.onWidgetResize((widgetId, w, h) => {
    dashboard.host(widgetId)?.onResize(w, h);
  });

  /**
   * Places one widget on the grid.
   *
   * @param {{id: string, type: string, config: object}} entry saved layout entry
   * @param {{x?: number, y?: number, w?: number, h?: number}} [geometry]
   */
  function place(entry, geometry = {}) {
    const definition = registry.get(entry.type);
    // An unknown type is a layout referencing a widget this build no longer
    // has. Skipping it must not stop the rest of the dashboard loading.
    if (!definition) return null;

    const { item, body, controls } = createTile({
      doc,
      widgetId: entry.id,
      title: definition.name,
      onSettings,
      onRemove: (id) => remove(id),
    });

    const node = nodeFromWidgetMeta(definition, gridHandle.breakpoint(), geometry);

    // `makeWidget`, not `addWidget`: in GridStack v13 `addWidget` takes a
    // widget *definition* and builds the element itself, which would discard
    // the tile built above. `makeWidget` adopts an element already in the DOM.
    gridHandle.root.appendChild(item);
    gridHandle.grid.makeWidget(item, node);

    // The host mounts the widget element into the tile body and owns it from
    // here: config, data, error boundary and teardown.
    const host = dashboard.add(entry, body);
    if (!host) return null;

    tiles.set(entry.id, { item, controls });
    return host;
  }

  /** Removes a widget from the grid and the dashboard together. */
  function remove(widgetId) {
    const tile = tiles.get(widgetId);
    if (tile) {
      gridHandle.grid.removeWidget(tile.item, true, false);
      tiles.delete(widgetId);
    }
    dashboard.remove(widgetId);
  }

  return {
    place,
    remove,

    /** Loads a saved layout: geometry from the grid, config from the entry. */
    load(entries = [], layoutNodes = []) {
      const geometryById = new Map(layoutNodes.map((n) => [n.id, n]));
      for (const entry of entries) {
        const node = geometryById.get(entry.id);
        place(entry, node ? { x: node.x, y: node.y, w: node.w, h: node.h } : {});
      }
    },

    /**
     * Inserts a widget chosen from the add panel.
     *
     * The stub config comes from the registry, so the new widget renders
     * something real immediately instead of an error card.
     */
    insert(insertion, idFactory = () => `${insertion.type}-${crypto.randomUUID().slice(0, 8)}`) {
      const id = idFactory();
      return place(
        { id, type: insertion.type, config: insertion.config },
        { w: insertion.size.w, h: insertion.size.h }
      );
    },

    tileFor: (widgetId) => tiles.get(widgetId) ?? null,
  };
}
