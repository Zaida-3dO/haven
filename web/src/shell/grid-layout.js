/**
 * The pure half of the grid layer — breakpoints, per-breakpoint extraction and
 * deep-link parsing, with no GridStack import.
 *
 * Split out from `grid.js` deliberately. GridStack's published ESM uses
 * extensionless relative imports, which Vite resolves and Node does not, so
 * anything importing it cannot be loaded by `node --test`. Keeping the logic
 * that actually encodes the design decisions on this side of that line means
 * the rules below are tested rather than merely asserted in a comment — and
 * `grid.js` is left as a thin layer of DOM and GridStack wiring.
 */

/** Column counts per breakpoint, matching `config/settings.example.json`. */
export const DEFAULT_COLUMNS = Object.freeze({ desktop: 12, mobile: 4 });

/** Viewport width at or below which the mobile breakpoint applies. */
export const DEFAULT_MOBILE_BREAKPOINT = 768;

/** How long a deep-linked widget stays highlighted. */
export const DEEP_LINK_HIGHLIGHT_MS = 2000;

/**
 * Which breakpoint a viewport width belongs to.
 *
 * Exported because the grid and the edit-mode UI must agree on it — edit mode
 * saves the breakpoint the user is actually looking at.
 */
export function breakpointForWidth(width, mobileMaxWidth = DEFAULT_MOBILE_BREAKPOINT) {
  return width <= mobileMaxWidth ? 'mobile' : 'desktop';
}

/**
 * Builds a GridStack node from a widget's static metadata.
 *
 * `minSize` maps to GridStack's `minW`/`minH`, which is what stops a widget
 * being resized below the size it can actually render at. `mobileSize` is
 * preferred on the mobile breakpoint; the registry defaults it to
 * `defaultSize` for a widget that declares none.
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
 * **The sharp edge, and the reason `hasCachedLayout` exists:**
 * `save(..., column)` substitutes GridStack's cached layout for that column
 * *only if one exists*. If the user has never been at that breakpoint there is
 * no cached layout, and GridStack returns the geometry of the column currently
 * rendered instead. Persisting that to the other breakpoint would silently
 * reflow desktop into mobile — precisely what DESIGN §3 rejects — so a caller
 * must not save a breakpoint that was never arranged.
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
 * Finds a widget's grid item, given its instance id.
 *
 * **Why this is not simply `[gs-id="..."]`:** GridStack consumes the `gs-id`
 * attribute into its internal node when it adopts an element, and removes it
 * from the DOM. Selecting on it therefore matches nothing once the grid is
 * live, which silently breaks every deep link. The host sets a real `id` on
 * each tile, so that is the primary lookup; `gs-id` is kept as a fallback for
 * an element the grid has not adopted yet.
 *
 * Returns the `.grid-stack-item` ancestor when there is one, because the
 * highlight belongs on the tile rather than on the host's inner div.
 */
export function findWidgetElement(root, widgetId) {
  if (!root || !widgetId) return null;

  const escaped = globalThis.CSS?.escape ? globalThis.CSS.escape(widgetId) : widgetId;
  const el =
    root.querySelector(`#${escaped}`) ?? root.querySelector(`[gs-id="${escaped}"]`) ?? null;
  if (!el) return null;

  return el.closest?.('.grid-stack-item') ?? el;
}

/** Reads a widget id out of a `#widget-id` style hash. */
export function widgetIdFromHash(hash) {
  if (typeof hash !== 'string') return null;
  const id = hash.replace(/^#/, '').trim();
  return id === '' ? null : decodeURIComponent(id);
}
