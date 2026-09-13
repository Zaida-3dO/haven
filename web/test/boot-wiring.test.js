import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

/**
 * Is each feature actually WIRED IN?
 *
 * `boot.js` cannot be imported under `node --test` (it pulls in GridStack,
 * whose ESM will not load there), so this reads it as text. That is a weaker
 * check than executing it — and still worth having, because the gap it closes
 * is one nothing else could see.
 *
 * Global search shipped complete: `SearchUI` was built, unit-tested, and
 * correct. `boot.js` simply never imported it, so Ctrl/Cmd-K did nothing in
 * the running app and an entire milestone was unreachable. Every test
 * constructed `SearchUI` directly, so no test ever asked whether anything
 * called it. A browser found it in seconds.
 *
 * The lesson generalises past search: a module can be perfect and still be
 * dead. So this asserts that every shell feature module is referenced by the
 * file that boots the app.
 */

const boot = readFileSync(new URL('../src/shell/boot.js', import.meta.url), 'utf8');

/** Modules that must be reachable from boot, and what breaks when they are not. */
const WIRED = [
  ['./search-ui.js', 'global search — Ctrl/Cmd-K does nothing without it'],
  ['./settings-panel.js', 'the settings gear — widget options are unreachable without it'],
  ['./grid.js', 'the grid itself'],
  ['./edit-mode.js', 'edit mode, save and discard'],
  ['./add-panel.js', 'adding a widget'],
  ['./router.js', 'subpages'],
  ['./layout-client.js', 'layout persistence'],
  ['./instances-client.js', 'the widget roster'],
];

for (const [module, why] of WIRED) {
  test(`boot.js imports ${module}`, () => {
    // A plain substring: the module path is a literal, so there is nothing
    // to pattern-match and nothing to escape.
    assert.ok(boot.includes(`from '${module}'`), `not wired in: ${why}`);
  });
}

test('SearchUI is constructed and its shortcut attached, not merely imported', () => {
  // Importing it is not enough — the bug was a live import away from working.
  assert.match(boot, /new SearchUI\(/, 'SearchUI is imported but never constructed');
  assert.match(boot, /attachShortcut\(/, 'SearchUI is constructed but its shortcut never attached');
  assert.match(boot, /\.mount\(/, 'SearchUI is constructed but never mounted');
});

test('every shell module with a default-ish entry point is reachable from boot', () => {
  // A widget or page is registered through its own index; this is about the
  // shell's own feature modules, which only `boot.js` can wire up.
  const shellDir = new URL('../src/shell/', import.meta.url);
  const optional = new Set([
    // Imported by the modules above rather than by boot directly.
    'boot.js',
    'shell.js',
    'dashboard.js',
    'dashboard-grid.js',
    'registry.js',
    'host.js',
    'schema.js',
    'migrate.js',
    'scheduler.js',
    'fetcher.js',
    'panel-data.js',
    'search-index.js',
    'grid-layout.js',
    'clock-source.js',
    'roster.js',
    'page-dom.js',
    // The transparent-background option. Imported by `dashboard-grid.js`
    // (which applies the class) and by the hero and apps definitions (which
    // declare the field), never by boot — there is nothing for boot to wire.
    // It is not unreachable: `transparent-option-contract.test.js` asserts
    // all three of those consumers, which is the real guard here.
    'transparent.js',
  ]);

  const unwired = readdirSync(shellDir)
    .filter((f) => f.endsWith('.js') && !optional.has(f))
    .filter((f) => !boot.includes(`'./${f}'`));

  assert.deepEqual(
    unwired,
    [],
    `these shell modules exist but nothing boots them: ${unwired.join(', ')}`
  );
});

/* -- the sidebar zone filter ---------------------------------------------- */

const BOOT_SRC = readFileSync(new URL('../src/shell/boot.js', import.meta.url), 'utf8');
const BOOT_NO_COMMENTS = BOOT_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('the grid is loaded from the roster with sidebar widgets filtered OUT', () => {
  // The roster carries every widget in the app now, both zones together
  // (`widgets.zone`, migration 005). If the sidebar-zoned entries are not
  // filtered out before `grid.load`, each one is ALSO mounted as a GridStack
  // tile: four unexpected tiles on the board, and the 3D home loads its whole
  // WebGL scene twice. Nothing throws — it just renders wrong.
  //
  // Comments are stripped first, so the prose above explaining the filter
  // cannot be what satisfies this.
  assert.match(
    BOOT_NO_COMMENTS,
    /zone\s*===\s*'sidebar'/,
    'boot.js never tests for the sidebar zone, so the grid gets every widget'
  );
  assert.match(
    BOOT_NO_COMMENTS,
    /reconcileRoster\(\s*gridInstances/,
    'the grid must be reconciled against the GRID-zoned subset, not the whole roster'
  );
});

test('a widget with no zone is treated as a grid widget', () => {
  // The fallback roster (`FALLBACK_INSTANCES`) carries no `zone` field at all,
  // and every entry in it is a grid widget. A filter written as
  // `zone !== 'grid'` would send all of them to the sidebar the moment
  // `GET /api/instances` failed — turning a degraded state into a broken one.
  assert.match(
    BOOT_NO_COMMENTS,
    /!isSidebarZone|zone\s*!==\s*'sidebar'/,
    'the grid subset must be "not sidebar" rather than "equals grid", so an ' +
      'entry with no zone still lands on the grid'
  );
});

test('edit mode is wired to the SIDEBAR, not only to the grid', () => {
  // `edit-mode.js` enables per-widget controls with
  // `gridHandle.root.querySelectorAll(...)` — scoped to the GRID's root. The
  // sidebar is mounted as a SIBLING of the grid chrome, so that sweep cannot
  // reach it: sidebar controls left to it are built disabled and stay disabled
  // forever. Nothing throws and no unit test of `sidebar.js` would notice,
  // because the capability exists — it is the WIRING that is missing.
  //
  // Comments are stripped first, so this prose cannot satisfy the assertion.
  assert.match(
    BOOT_NO_COMMENTS,
    /onModeChange:/,
    'boot.js never passes onModeChange, so entering edit mode cannot reach the sidebar'
  );
  assert.match(
    BOOT_NO_COMMENTS,
    /sidebar\?\.setEditable\(/,
    'edit mode must drive the sidebar own control sweep'
  );
  assert.match(
    BOOT_NO_COMMENTS,
    /haven-layout--edit-mode/,
    'the layout needs its own edit class, or the sidebar controls never become visible'
  );
});
