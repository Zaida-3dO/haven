/**
 * Booting the full dashboard: host + grid + edit mode.
 *
 * `shell.js` exposes the widget host on its own (a `Dashboard` rendering into
 * a plain container). This is the grid-backed boot: the same dashboard, laid
 * out on GridStack, with the edit-mode toolbar and the add-widget panel.
 *
 * Kept separate from `shell.js` so the host stays usable — and testable —
 * without pulling GridStack in, which matters because GridStack's ESM cannot
 * be loaded under `node --test`.
 */

import { Dashboard } from './dashboard.js';
import { registry } from './registry.js';
import { createAddPanel } from './add-panel.js';
import { createEditMode, createEditToolbar } from './edit-mode.js';
import { connectGrid } from './dashboard-grid.js';
import { createLayoutClient } from './layout-client.js';
import { installDeepLinks, mountGrid } from './grid.js';
import { startClockTicks } from './clock-source.js';
import { register as registerClock } from '../widgets/clock/index.js';
import { register as registerApps } from '../widgets/apps/index.js';
import { register as registerTorrents } from '../widgets/torrents/index.js';
import { register as registerCalendar } from '../widgets/calendar/index.js';

/**
 * The widget instances on the dashboard.
 *
 * The layout API stores geometry per breakpoint and, on each node, an optional
 * `widgetId`. What it does not store is which widget *type* an instance is, or
 * its config — there is no instances endpoint yet. Until there is, the roster
 * lives here so the grid work is demonstrable end to end; replacing this with
 * a fetch is a one-line change in this file.
 */
const DEFAULT_INSTANCES = [
  // The apps widget replaces the old dashboard's whole front page, so it leads.
  { id: 'apps-main', type: 'apps', config: {} },
  { id: 'clock-local', type: 'clock', config: { label: 'Local time', source: 'local' } },
  { id: 'torrents', type: 'torrents', config: { maxRows: 6 } },
  { id: 'calendar', type: 'calendar', config: { title: 'Calendar', maxEvents: 25 } },
  {
    id: 'clock-tokyo',
    type: 'clock',
    config: { label: 'Tokyo', source: 'timezone', timezone: 'Asia/Tokyo', showSeconds: 'yes' },
  },
];

/**
 * Boots the grid-backed dashboard into `root`.
 *
 * @param {HTMLElement} root
 * @param {object} [options]
 * @param {HTMLElement} [options.chrome] where the toolbar and add panel go
 */
export async function bootDashboard(root, { chrome = root.parentElement, instances } = {}) {
  if (!root) throw new Error('bootDashboard: no root element');

  registerClock(registry);
  registerApps(registry);
  registerTorrents(registry);
  registerCalendar(registry);

  const layoutClient = createLayoutClient();
  const dashboard = new Dashboard({ registry, container: root });
  const gridHandle = mountGrid({ root });

  const grid = connectGrid({ dashboard, gridHandle, registry });

  // Geometry comes from the server; which widgets exist comes from the roster.
  // A layout that fails to load must not leave a blank page, so the widgets are
  // placed either way — just at their default positions.
  let saved = { desktop: [], mobile: [] };
  try {
    ({ layout: saved } = await layoutClient.load());
  } catch (error) {
    console.warn('Haven: could not load the saved layout, using defaults.', error);
  }

  const roster = instances ?? DEFAULT_INSTANCES;
  grid.load(roster, saved[gridHandle.breakpoint()] ?? []);

  // The clock's tick is a host-owned scheduler task — see clock-source.js.
  for (const entry of roster) {
    if (entry.type !== 'clock') continue;
    const host = dashboard.host(entry.id);
    if (host) startClockTicks({ scheduler: dashboard.scheduler, host });
  }

  const addPanel = createAddPanel({
    registry,
    breakpoint: () => gridHandle.breakpoint(),
    onAdd: (insertion) => {
      const host = grid.insert(insertion);
      if (host && insertion.type === 'clock') {
        startClockTicks({ scheduler: dashboard.scheduler, host });
      }
    },
  });

  const editMode = createEditMode({
    gridHandle,
    layoutClient,
    addPanel,
    onError: (error) => console.error('Haven: saving the layout failed.', error),
  });

  const toolbar = createEditToolbar({ editMode });

  if (chrome) {
    chrome.prepend(toolbar.el);
    chrome.appendChild(addPanel.el);
  }

  const teardownDeepLinks = installDeepLinks(gridHandle);

  dashboard.start();

  return {
    dashboard,
    gridHandle,
    grid,
    editMode,
    addPanel,
    toolbar,
    destroy() {
      teardownDeepLinks();
      dashboard.destroy();
      gridHandle.destroy();
    },
  };
}
