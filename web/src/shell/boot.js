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
import { createHeader } from './header.js';
import { createProfileMenu } from './profile-menu.js';
import { createSidebar } from './sidebar.js';
import { createEditMode, createEditToolbar } from './edit-mode.js';
import { connectGrid } from './dashboard-grid.js';
import { connectSettings } from './settings-panel.js';
import { createLayoutClient } from './layout-client.js';
import { createInstancesClient, secretKeysOf } from './instances-client.js';
import { reconcileRoster } from './roster.js';
import { installDeepLinks, mountGrid } from './grid.js';
import { SearchUI } from './search-ui.js';
import { startClockTicks } from './clock-source.js';
import { register as registerClock } from '../widgets/clock/index.js';
import { defineHeroWidget } from '../widgets/hero/index.js';
import { register as registerApps } from '../widgets/apps/index.js';
import { register as registerTorrents } from '../widgets/torrents/index.js';
import { register as registerCalendar } from '../widgets/calendar/index.js';
import { defineWeatherWidget } from '../widgets/weather/index.js';
import { defineStatusWidget } from '../widgets/status/index.js';
import { defineIframeWidget } from '../widgets/iframe/index.js';
import { definePageWidget } from '../widgets/page/index.js';
import { createRouter } from './router.js';
import { pageRegistry } from '../pages/registry.js';
import { libraryAnalyticsPage } from '../pages/library-analytics.js';
import { HOME_3D_PREVIEW_URL } from '../widgets/iframe/definition.js';

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
  // NOTE the 3D home is deliberately NOT here. It is a SIDEBAR card, matching
  // the live dashboard, and the sidebar builds its own instances further down
  // — see `SIDEBAR_INSTANCES`. Leaving a copy here as well would mount the
  // same embed twice and load the 3D scene twice with it.
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
  {
    chrome = root.parentElement,
    instances,
    pageRoot = null,
    pages = pageRegistry,
    layoutRoot = null,
  } = {}
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
  // Both of these are mounted into the SIDEBAR rather than the grid, but they
  // are registered the same way as everything else: the sidebar mounts real
  // widget hosts, so they go through migration, validation, the error boundary
  // and the host's schedule exactly like a grid tile does.
  defineWeatherWidget({ registry });
  defineStatusWidget({ registry });

  // Custom pages are authored once and placed twice — as a subpage below, and
  // as a `page` widget on the grid. Both read this one registry.
  if (!pages.has(libraryAnalyticsPage.id)) pages.register(libraryAnalyticsPage);

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
      // Chrome options live on the TILE, which `setConfig` does not touch —
      // it updates the widget inside it. Without this the transparent option
      // would save correctly and appear to do nothing until the next reload.
      grid?.refreshChrome?.(widgetId);
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

  // ── Split the roster by ZONE before anything is placed ────────────────
  // The roster now carries every widget in the app, sidebar ones included
  // (`widgets.zone`, migration 005). The grid must only ever see its own.
  //
  // Without this filter the four sidebar instances are ALSO handed to
  // `grid.load`, which mounts each of them a second time as a GridStack tile:
  // four unexpected tiles appear on the board, and the 3D home in particular
  // loads its whole WebGL scene twice — once in the sidebar and once on the
  // grid. Nothing throws; it just renders wrong and costs a second scene load.
  //
  // A widget with no zone at all is treated as a GRID widget, matching
  // migration 005's `DEFAULT 'grid'` and the server's `DEFAULT_ZONE`. That
  // matters for the FALLBACK_INSTANCES path: those entries carry no `zone`
  // field, and they are all grid widgets.
  const isSidebarZone = (entry) => entry?.zone === 'sidebar';
  const gridInstances = loaded.filter((entry) => !isSidebarZone(entry));
  const sidebarInstances = loaded.filter(isSidebarZone);

  const nodes = saved[gridHandle.breakpoint()] ?? [];
  const { roster: entries, usable } = reconcileRoster(gridInstances, nodes);
  for (const entry of entries) roster.set(entry.id, entry);

  grid.load(entries, usable);

  // The clock's tick is a host-owned scheduler task — see clock-source.js.
  // Its teardown is handed to the dashboard rather than discarded: the task is
  // registered as `clock-tick:<id>`, which `dashboard.remove(id)` cannot cancel
  // by id, so dropping it leaks a 1 Hz task per clock removed.
  const startClock = (host) => {
    dashboard.onRemove(host.id, startClockTicks({ scheduler: dashboard.scheduler, host }));
  };

  for (const entry of entries) {
    if (entry.type !== 'clock') continue;
    const host = dashboard.host(entry.id);
    if (host) startClock(host);
  }

  const addPanel = createAddPanel({
    registry,
    breakpoint: () => gridHandle.breakpoint(),
    onAdd: (insertion) => {
      const host = grid.insert(insertion);
      if (!host) return;
      if (insertion.type === 'clock') startClock(host);

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

  /**
   * The profile menu — where "Edit dashboard" lives now.
   *
   * It used to be a bare button in the top-left, the first thing on the page:
   * the most prominent position on screen given to the rarest action. The
   * dashboard Haven replaces has no edit affordance at all, and it is right
   * not to — a dashboard is overwhelmingly a thing you look at.
   *
   * The item's label is kept in step with the toolbar's own toggle, so the
   * menu says "Done editing" while you are editing rather than offering to
   * enter a mode you are already in.
   */
  const profile = createProfileMenu({
    items: [
      {
        id: 'edit',
        label: 'Edit dashboard',
        onSelect: () => {
          editMode.toggle();
          toolbar.sync();
          syncProfileLabel();
        },
      },
    ],
  });

  function syncProfileLabel() {
    profile.setItemLabel('edit', editMode.isEditing ? 'Done editing' : 'Edit dashboard');
  }

  // The toolbar's own toggle and the menu item drive the same mode, so
  // whichever one is used, the other's label has to follow.
  toolbar.toggle.addEventListener('click', () => syncProfileLabel());
  toolbar.save.addEventListener('click', () => syncProfileLabel());
  toolbar.discard.addEventListener('click', () => syncProfileLabel());

  /**
   * Re-evaluate the toolbar whenever the layout moves.
   *
   * Save is disabled until there is something to save, and "something to
   * save" is a function of the live grid — so it has to be recomputed when
   * the grid changes, not only when a button is pressed. Without this the
   * button's state is decided once on entering edit mode and never updated,
   * which means it stays greyed out through the first drag: the feature would
   * be invisible in the browser while every unit test still passed.
   */
  const teardownDirtySync = gridHandle.onLayoutChange(() => toolbar.sync());

  /**
   * The header.
   *
   * Built before the toolbar is prepended so it can be prepended AFTER it and
   * therefore end up above it — `prepend` puts each new node first, so the
   * last prepend wins. The header goes outside `#haven-chrome`'s padding
   * (inserted before it in the body) so its bar spans the full window width
   * the way a fixed header must, rather than being inset by the chrome's
   * gutter.
   *
   * Its search button opens the SAME palette the Ctrl/Cmd-K shortcut opens —
   * `searchUI` is constructed below, so this reads it lazily through a
   * closure rather than capturing an undefined value now.
   */
  const header = createHeader({
    onSearch: () => searchUI?.open(),
    profile: profile.el,
  });

  if (chrome) {
    chrome.prepend(toolbar.el);
    chrome.appendChild(addPanel.el);
    chrome.appendChild(settingsPanel.el);
  }

  /**
   * The sidebar.
   *
   * Mounted as a sibling of `#haven-chrome` inside `.haven-layout`, which is
   * the grid that gives it its 320px column. Its widgets are real hosts on the
   * dashboard's own scheduler — they simply render into the sidebar's card
   * bodies instead of into a GridStack tile.
   *
   * Order is weather · calendar · 3D home · status, with status pinned to the
   * bottom, matching the live dashboard (which runs weather · rooms · 3D home
   * · status). The calendar is OURS and deliberate, standing where the live
   * dashboard has its rooms list: the live one has no calendar at all, and a
   * glanceable list of what is coming up is exactly the kind of ambient
   * context this column is for.
   *
   * The 3D home moved here FROM the main grid. It is an ambient readout —
   * something you glance at — rather than something you interact with on the
   * board, which is the same test every other card in this column passes, and
   * it is where the live dashboard puts it.
   */
  const layoutEl = layoutRoot ?? chrome?.parentElement ?? null;

  /**
   * How a sidebar widget PRESENTS: its heading and its icon.
   *
   * Keyed by widget type, not by instance id, because ids are minted once the
   * roster is real data. Deliberately not taken from the registry's `name`:
   * that is the add-panel's label for the widget KIND ("Embed", "Status"),
   * whereas these are content headings naming what this card shows in this
   * column ("3D Home", "Server Status"). The live dashboard makes the same
   * distinction. A type with no entry here still renders — it falls back to
   * the registry name and no icon — so an unknown widget dropped into the
   * sidebar degrades to a plain titled card rather than vanishing.
   */
  const SIDEBAR_PRESENTATION = {
    weather: { title: 'Weather', icon: 'weather' },
    calendar: { title: 'Calendar', icon: 'calendar' },
    iframe: { title: '3D Home', icon: 'home3d' },
    status: { title: 'Server Status', icon: 'status' },
  };

  /**
   * `status` holds the bottom of the column.
   *
   * Kept a CONSTANT of the type rather than a per-instance flag: the pin is a
   * property of what the status card IS — the summary of everything above it,
   * and the one card whose height does not depend on its content — not a
   * preference a user sets per widget. Only one card can hold the bottom, so
   * making it per-instance would immediately raise "what if two are pinned".
   */
  const PINNED_SIDEBAR_TYPE = 'status';

  /** One `createSidebar` card spec per sidebar instance, in roster order. */
  const cardSpecFor = (entry) => {
    const presentation = SIDEBAR_PRESENTATION[entry.type] ?? {};
    return {
      id: entry.id,
      type: entry.type,
      title: presentation.title ?? registry.get(entry.type)?.name ?? entry.type,
      icon: presentation.icon,
      pinned: entry.type === PINNED_SIDEBAR_TYPE,
    };
  };

  /** Widget instances that live in the sidebar rather than on the grid. */
  const SIDEBAR_INSTANCES = [
    { card: 'weather', id: 'sidebar-weather', type: 'weather', config: {} },
    {
      card: 'calendar',
      id: 'sidebar-calendar',
      type: 'calendar',
      config: { title: 'Calendar', maxEvents: 8 },
    },
    // A public HTTPS URL: the 3D home is deployed standalone rather than
    // served by Haven, so this is a cross-origin embed. A public hostname is
    // not network topology, so it is fine in a public repo. The sandbox stays
    // as locked down as it was on the grid — the scene needs no storage.
    //
    // `HOME_3D_PREVIEW_URL`, not `HOME_3D_URL`: this card is an ambient
    // readout, so it embeds the 3D home's `?preview=true` route — auto-
    // rotating, non-interactive, and with its own chrome (including the
    // controls button) hidden. The plain interactive URL stays the default for
    // a user-added embed widget, where clicking a room is the point.
    {
      card: 'home3d',
      id: 'sidebar-home3d',
      type: 'iframe',
      config: {
        url: HOME_3D_PREVIEW_URL,
        title: '3D home',
        scroll: 'no',
        allowForms: 'no',
        allowPopups: 'no',
        allowSameOrigin: 'no',
      },
    },
    { card: 'status', id: 'sidebar-status', type: 'status', config: {} },
  ];

  // The seeded roster is the source. `SIDEBAR_INSTANCES` above is the fallback
  // for when `GET /api/instances` FAILED — the same rule as the grid's
  // `FALLBACK_INSTANCES`, and for the same reason: an empty sidebar is a
  // legitimate state (the user removed every card) and must render empty,
  // whereas a failed request is not a statement about the roster at all.
  const sidebarEntries = loaded === FALLBACK_INSTANCES ? SIDEBAR_INSTANCES : sidebarInstances;

  const sidebar = layoutEl ? createSidebar({ cards: sidebarEntries.map(cardSpecFor) }) : null;

  if (sidebar) {
    layoutEl.appendChild(sidebar.el);
    for (const entry of sidebarEntries) {
      // Keyed by INSTANCE ID now, not by a hardcoded `card:` name — the card
      // specs above are built from the same entries, so the two agree by
      // construction rather than by a literal matching in two places.
      const body = sidebar.bodies.get(entry.id);
      if (!body) continue;
      // `dashboard.add` and not `grid.place`: these get a host, a config, the
      // error boundary and a scheduled refresh, but no GridStack node — which
      // is the whole distinction between the sidebar and the grid.
      dashboard.add({ id: entry.id, type: entry.type, config: entry.config ?? {} }, body);
    }
  }

  // Full-bleed: before the LAYOUT element, not inside the chrome's padded box,
  // so the bar spans the whole window above both columns.
  if (layoutEl) layoutEl.parentElement?.insertBefore(header.el, layoutEl);
  else chrome?.parentElement?.insertBefore(header.el, chrome);

  const teardownDeepLinks = installDeepLinks(gridHandle);

  /**
   * Global search.
   *
   * Mounted here because nothing else was mounting it: `SearchUI` was built,
   * unit-tested and complete, but `boot.js` never imported it — so the whole
   * feature was unreachable in the running app and Ctrl/Cmd-K did nothing.
   * A browser found that in seconds; the test suite could not, because every
   * test constructs `SearchUI` directly and so never asks whether anything
   * calls it.
   *
   * It reuses the deep-link seam rather than reaching into the grid: jumping
   * to a result is the same act as following a `#widget-id` link, and one
   * scroll-and-highlight implementation is enough.
   */
  const searchUI = new SearchUI(dashboard.searchIndex, {
    navigateToWidget: (id) => gridHandle.focus(id),
  });
  searchUI.mount(chrome ?? document.body);
  const teardownSearchShortcut = searchUI.attachShortcut();

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
    searchUI,
    toolbar,
    header,
    profile,
    sidebar,
    router,
    pages,
    destroy() {
      settingsPanel.close();
      // The profile menu holds a capture-phase document click listener; a boot
      // torn down without this leaks one per boot and keeps the whole menu
      // closure alive.
      profile.destroy();
      sidebar?.el.remove();
      // The header's clock holds an interval; a boot torn down without this
      // leaks one timer per boot.
      header.destroy();
      header.el.remove();
      teardownSearchShortcut();
      teardownDeepLinks();
      teardownDirtySync();
      router?.destroy();
      dashboard.destroy();
      gridHandle.destroy();
    },
  };
}
