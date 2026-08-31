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

import { registry } from './registry.js';
import { Dashboard } from './dashboard.js';

/**
 * Boot the shell into `root`.
 *
 * Widgets register themselves (by importing their module) before or after this
 * runs — late registration is handled by the host, so load order does not
 * matter.
 */
export function mountShell(root, { layout = [] } = {}) {
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

  return dashboard;
}
