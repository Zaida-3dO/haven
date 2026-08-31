/**
 * The widget shell.
 *
 * The shell owns fetching, caching, auth, dedup and refresh; widgets are
 * near-pure render functions that receive data and draw it. See
 * docs/WIDGET-CONTRACT.md — that split is the single most important
 * decision in this codebase and every widget depends on it.
 *
 * This module is the public surface of the host: the registry to register
 * against, and a `Dashboard` that owns the timers.
 */

export { registry, WidgetRegistry } from './registry.js';
export { Dashboard } from './dashboard.js';
export { WidgetHost, HOST_STATE, LATE_REGISTRATION_GRACE_MS } from './host.js';
export { Scheduler } from './scheduler.js';
export { Fetcher } from './fetcher.js';
export { loadingData, doneData, errorData, staleData, LOADING, DONE, ERROR } from './panel-data.js';
export {
  validateConfig,
  parseConfig,
  buildFormModel,
  visibleFields,
  isVisible,
  applyDefaults,
  ConfigError,
  FIELD_TYPES,
} from './schema.js';
export { migrateConfig, MigrationError, VERSION_KEY } from './migrate.js';
export { SearchIndex, scoreEntry, MATCH } from './search-index.js';
export { SearchUI, SEARCH_UI_STATE, isOpenShortcut, defaultActionFor } from './search-ui.js';

import { registry } from './registry.js';
import { Dashboard } from './dashboard.js';
import { SearchUI } from './search-ui.js';

/**
 * Boot the shell into `root`.
 *
 * Widgets register themselves (by importing their module) before or after this
 * runs — late registration is handled by the host, so load order does not
 * matter.
 */
export function mountShell(root, { layout = [], navigateToWidget = null } = {}) {
  if (!root) throw new Error('mountShell: no root element');

  root.replaceChildren();

  const dashboard = new Dashboard({ registry, container: root });
  for (const entry of layout) dashboard.add(entry);
  dashboard.start();

  if (layout.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'haven-boot';
    empty.textContent = 'Haven — no widgets yet.';
    root.appendChild(empty);
  }

  // Global search over the dashboard's in-memory index. `navigateToWidget` is
  // the seam onto the grid's `#widget-id` scroll-and-highlight; left null it
  // falls back to setting the hash, which is what the grid listens for.
  const search = new SearchUI(dashboard.searchIndex, { navigateToWidget });
  search.mount(root);
  search.attachShortcut();

  // Still the Dashboard, so existing callers are unaffected; the palette
  // rides along on it rather than changing this function's return shape.
  dashboard.search = search;
  return dashboard;
}
