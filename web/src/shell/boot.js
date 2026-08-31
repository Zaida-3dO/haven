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
import { createInstancesClient, secretKeysOf } from './instances-client.js';
import { installDeepLinks, mountGrid } from './grid.js';
import { startClockTicks } from './clock-source.js';
import { register as registerClock } from '../widgets/clock/index.js';
import { defineHeroWidget } from '../widgets/hero/index.js';
import { register as registerApps } from '../widgets/apps/index.js';
import { register as registerTorrents } from '../widgets/torrents/index.js';
import { register as registerCalendar } from '../widgets/calendar/index.js';

/**
 * The fallback roster.
 *
 * The roster now comes from `GET /api/instances` and the server seeds the same
 * list into the database on a fresh install (`DEFAULT_INSTANCES` in
 * `server/src/db/instances-store.js`). This copy is what the shell falls back
 * to when that request FAILS — not when it comes back empty.
 *
 * That distinction is the whole reason it still exists. An empty roster is a
 * legitimate state (the user removed every widget) and must render as an empty
 * dashboard. A failed request is not a statement about the roster at all, and
 * treating it as one would blank a working dashboard because the server
 * hiccuped.
 */
const FALLBACK_INSTANCES = [
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
];

/**
 * Drops roster entries the layout still references but that no longer exist,
 * and vice versa — the dangling-reference guard.
 *
 * A layout node whose `widgetId` names an instance that is gone must not blank
 * the dashboard: it is skipped and the rest loads. `connectGrid.load` already
 * walks the ROSTER and looks geometry up per entry, so an extra layout node is
 * inert by construction. This exists for the other direction and for the
 * explicit `widgetId` spelling, so the intent is stated rather than relied on
 * as an accident of iteration order.
 */
export function reconcileRoster(roster = [], layoutNodes = []) {
  const known = new Set(roster.map((entry) => entry?.id).filter(Boolean));
  const usable = layoutNodes.filter((node) => {
    const target = node?.widgetId ?? node?.id;
    return typeof target === 'string' && known.has(target);
  });
  return { roster: roster.filter((entry) => entry && typeof entry.id === 'string'), usable };
}

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

  // The hero needs no per-instance wiring: its rotation rides the shared
  // ticker, which the element subscribes to on connect.
  defineHeroWidget({ registry });

  const layoutClient = createLayoutClient();
  const instancesClient = instances ? null : createInstancesClient();
  const dashboard = new Dashboard({ registry, container: root });
  const gridHandle = mountGrid({ root });

  /** The roster as last known, so a save can send the whole instance back. */
  const roster = new Map();

  /**
   * Persists one instance through the API.
   *
   * `onSaved` rather than `onSave`: `connectSettings`'s own `onSave` is the
   * one that runs `host.setConfig()`, and that is the path that runs
   * `migrateConfig` then `parseConfig`. Persisting from `onSaved` means the
   * config written to the database is the one that already came out of the
   * migration hook — so the hook is never bypassed, and a config saved today
   * is stored at today's version.
   */
  async function persist(widgetId, config) {
    if (!instancesClient) return;
    const entry = roster.get(widgetId);
    if (!entry) return;

    const next = { ...entry, config };
    roster.set(widgetId, next);

    await instancesClient.save(widgetId, next, {
      secretKeys: secretKeysOf(registry.get(entry.type)),
    });
  }

  // The settings panel is built before the grid so the gear can be wired to
  // it directly. Until now that callback was a no-op and every widget option
  // was reachable only by editing the database.
  const settingsPanel = connectSettings({
    dashboard,
    registry,
    onSaved: (widgetId, config) => {
      // Fire-and-report: the widget has already been updated in place by
      // `setConfig`, so a failed write must not undo that or throw into the
      // panel's close path. It is logged, and the next load reveals it.
      void persist(widgetId, config).catch((error) =>
        console.error('Haven: could not persist widget settings.', error)
      );
    },
    onError: (error) => console.error('Haven: saving widget settings failed.', error),
  });

  const grid = connectGrid({
    dashboard,
    gridHandle,
    registry,
    onSettings: (widgetId) => settingsPanel.open(widgetId),
    onRemoved: (widgetId) => {
      roster.delete(widgetId);
      if (!instancesClient) return;
      // Deleting server-side also drops the layout node and the instance's
      // stored credentials — see `instances-store.delete`.
      void instancesClient
        .remove(widgetId)
        .catch((error) => console.error('Haven: could not delete the widget instance.', error));
    },
  });

  // Geometry comes from the server; so, now, does the roster. Neither request
  // failing may leave a blank page: the layout falls back to default positions
  // and the roster to a built-in list, so the dashboard always renders.
  let saved = { desktop: [], mobile: [] };
  try {
    ({ layout: saved } = await layoutClient.load());
  } catch (error) {
    console.warn('Haven: could not load the saved layout, using defaults.', error);
  }

  let loaded = instances ?? null;
  if (!loaded) {
    try {
      loaded = await instancesClient.load();
    } catch (error) {
      // A FAILED request, not an empty roster: an empty roster is a legitimate
      // "the user removed everything" and renders as an empty dashboard.
      console.warn('Haven: could not load the widget roster, using defaults.', error);
      loaded = FALLBACK_INSTANCES;
    }
  }

  const nodes = saved[gridHandle.breakpoint()] ?? [];
  const { roster: entries, usable } = reconcileRoster(loaded, nodes);
  for (const entry of entries) roster.set(entry.id, entry);

  grid.load(entries, usable);

  // The clock's tick is a host-owned scheduler task — see clock-source.js.
  for (const entry of entries) {
    if (entry.type !== 'clock') continue;
    const host = dashboard.host(entry.id);
    if (host) startClockTicks({ scheduler: dashboard.scheduler, host });
  }

  const addPanel = createAddPanel({
    registry,
    breakpoint: () => gridHandle.breakpoint(),
    onAdd: (insertion) => {
      const host = grid.insert(insertion);
      if (!host) return;
      if (insertion.type === 'clock') {
        startClockTicks({ scheduler: dashboard.scheduler, host });
      }

      // A widget added and not persisted is one that vanishes on refresh —
      // the exact bug this whole task exists to close. The host's config is
      // used rather than the insertion's, because it has been through
      // `migrateConfig` and `parseConfig` already.
      const entry = { id: host.id, type: insertion.type, config: host.config ?? {} };
      roster.set(host.id, entry);
      if (!instancesClient) return;
      void instancesClient
        .create(entry, { secretKeys: secretKeysOf(registry.get(insertion.type)) })
        .catch((error) => console.error('Haven: could not persist the new widget.', error));
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

  dashboard.start();

  return {
    dashboard,
    gridHandle,
    grid,
    editMode,
    addPanel,
    settingsPanel,
    toolbar,
    destroy() {
      settingsPanel.close();
      teardownDeepLinks();
      dashboard.destroy();
      gridHandle.destroy();
    },
  };
}
