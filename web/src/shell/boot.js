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
import { connectSettings } from './settings-panel.js';
import { createLayoutClient } from './layout-client.js';
import { installDeepLinks, mountGrid } from './grid.js';
import { startClockTicks } from './clock-source.js';
import { register as registerClock } from '../widgets/clock/index.js';
import { defineHeroWidget } from '../widgets/hero/index.js';
import { register as registerApps } from '../widgets/apps/index.js';
import { register as registerTorrents } from '../widgets/torrents/index.js';
import { register as registerCalendar } from '../widgets/calendar/index.js';
import { defineIframeWidget } from '../widgets/iframe/index.js';
import { definePageWidget } from '../widgets/page/index.js';
import { createRouter } from './router.js';
import { pageRegistry } from '../pages/registry.js';
import { libraryAnalyticsPage } from '../pages/library-analytics.js';
import { HOME_3D_URL } from '../widgets/iframe/definition.js';

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
  // The hero is a banner across the top, so it comes before the apps grid.
  { id: 'hero-main', type: 'hero', config: { rotateSeconds: 8, showTagline: true } },
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
  // The 3D home preview — the iframe widget's first consumer. A relative path,
  // because the 3D home is served from Haven's own origin and an absolute
  // internal address must never be committed to a public repo.
  {
    id: 'embed-home3d',
    type: 'iframe',
    config: {
      url: HOME_3D_URL,
      title: '3D home',
      scroll: 'no',
      allowForms: 'no',
      allowPopups: 'no',
      allowSameOrigin: 'no',
    },
  },
  // A summary tile linking through to the Library Analytics subpage. The page
  // itself is a whole screen with its own header, so the tile links rather
  // than trying to squeeze it into four cells.
  {
    id: 'page-library',
    type: 'page',
    config: { pageId: 'library-analytics', mode: 'summary' },
  },
];

/**
 * Boots the grid-backed dashboard into `root`.
 *
 * @param {HTMLElement} root
 * @param {object} [options]
 * @param {HTMLElement} [options.chrome] where the toolbar and add panel go
 */
export async function bootDashboard(
  root,
  { chrome = root.parentElement, instances, pageRoot = null, pages = pageRegistry } = {}
) {
  if (!root) throw new Error('bootDashboard: no root element');

  registerClock(registry);
  registerApps(registry);
  registerTorrents(registry);
  registerCalendar(registry);

  // The hero needs no per-instance wiring: its rotation rides the shared
  // ticker, which the element subscribes to on connect.
  defineHeroWidget({ registry });
  defineIframeWidget({ registry });
  definePageWidget({ registry });

  // Custom pages are authored once and placed twice — as a subpage below, and
  // as a `page` widget on the grid. Both read this one registry.
  if (!pages.has(libraryAnalyticsPage.id)) pages.register(libraryAnalyticsPage);

  const layoutClient = createLayoutClient();
  const dashboard = new Dashboard({ registry, container: root });
  const gridHandle = mountGrid({ root });

  // The settings panel is built before the grid so the gear can be wired to
  // it directly. Until now that callback was a no-op and every widget option
  // was reachable only by editing the database.
  const settingsPanel = connectSettings({
    dashboard,
    registry,
    onError: (error) => console.error('Haven: saving widget settings failed.', error),
  });

  const grid = connectGrid({
    dashboard,
    gridHandle,
    registry,
    onSettings: (widgetId) => settingsPanel.open(widgetId),
  });

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
  // Its teardown is handed to the dashboard rather than discarded: the task is
  // registered as `clock-tick:<id>`, which `dashboard.remove(id)` cannot cancel
  // by id, so dropping it leaks a 1 Hz task per clock removed.
  const startClock = (host) => {
    dashboard.onRemove(host.id, startClockTicks({ scheduler: dashboard.scheduler, host }));
  };

  for (const entry of roster) {
    if (entry.type !== 'clock') continue;
    const host = dashboard.host(entry.id);
    if (host) startClock(host);
  }

  const addPanel = createAddPanel({
    registry,
    breakpoint: () => gridHandle.breakpoint(),
    onAdd: (insertion) => {
      const host = grid.insert(insertion);
      if (host && insertion.type === 'clock') startClock(host);
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
    chrome.appendChild(settingsPanel.el);
  }

  const teardownDeepLinks = installDeepLinks(gridHandle);

  /**
   * Subpage routing.
   *
   * The dashboard is deliberately left mounted underneath a subpage rather
   * than destroyed: tearing down every widget to look at an analytics page and
   * rebuilding them on the way back would reload every iframe on the board,
   * which is exactly what the iframe widget exists to avoid.
   */
  const router = pageRoot ? createRouter({ pages, gridRoot: root, pageRoot }) : null;

  dashboard.start();

  return {
    dashboard,
    gridHandle,
    grid,
    editMode,
    addPanel,
    settingsPanel,
    toolbar,
    router,
    pages,
    destroy() {
      settingsPanel.close();
      teardownDeepLinks();
      router?.destroy();
      dashboard.destroy();
      gridHandle.destroy();
    },
  };
}
