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

test('an add destined for the SIDEBAR never goes through the grid', () => {
  // Caught by mutation testing: disabling this branch entirely — so a widget
  // chosen for the sidebar silently appears on the grid instead — killed no
  // test at all. That is the first bug a user would hit after choosing
  // "Sidebar" in the add panel, and nothing was watching it.
  //
  // `grid.insert` mints a GridStack node and calls `makeWidget`, which puts
  // the widget on the board; `buildInsertion` carries no geometry for this
  // zone, so there is nothing for the grid to place even if it tried.
  //
  // Comments are stripped first, so the prose above cannot satisfy this.
  assert.match(
    BOOT_NO_COMMENTS,
    /insertion\.zone === 'sidebar'/,
    'boot.js never branches on the insertion zone, so the add panel destination is inert'
  );
  assert.match(
    BOOT_NO_COMMENTS,
    /sidebarZone\.add\(/,
    'a sidebar insertion must be added through the sidebar zone, not the grid'
  );

  // And the branch must RETURN rather than falling through into grid.insert:
  // without the early return the widget is added to BOTH zones at once.
  //
  // Sliced by index rather than matched with a multiline regex — a JS regex
  // literal cannot span lines, and writing one that tries is a syntax error
  // that takes the whole test file down with it.
  const branchAt = BOOT_NO_COMMENTS.indexOf("insertion.zone === 'sidebar'");
  const gridInsertAt = BOOT_NO_COMMENTS.indexOf('grid.insert(insertion)', branchAt);
  assert.ok(branchAt >= 0 && gridInsertAt > branchAt, 'could not locate the sidebar branch');

  // The branch must END with `return;` — not merely CONTAIN one.
  //
  // Caught by mutation testing, and worth recording: the first version of this
  // asserted `branchBody.includes('return;')` and was vacuous. The branch has
  // four guard returns of its own (`if (!sidebarZone) return;` and friends),
  // so removing the FINAL return — the one that stops a sidebar widget also
  // being inserted into the grid — left the assertion passing happily.
  //
  // Sliced to the branch's own closing brace, NOT to `grid.insert`: everything
  // between the two — the blank line and `const host = ` — is outside the
  // branch, and including it means nothing can ever match "ends with a
  // return". (That mistake made this assertion fail on correct source, which
  // is just as useless as one that passes on broken source.)
  const closingBraceAt = BOOT_NO_COMMENTS.lastIndexOf('}', gridInsertAt);
  const branchBody = BOOT_NO_COMMENTS.slice(branchAt, closingBraceAt);
  assert.match(
    branchBody.trimEnd(),
    /return;$/,
    'the sidebar branch must END with a return, or the widget is inserted into ' +
      'the grid as well as the sidebar'
  );
});

/* -- the sidebar settings gear ------------------------------------------- */

test('the sidebar is given the SAME settings panel the grid opens', () => {
  // The acceptance criterion this task exists for: reuse the grid's settings
  // panel rather than build a second one. `settingsPanel` is constructed once
  // (`connectSettings`), well before `createSidebar` is called, so this checks
  // the sidebar's own `onSettings` calls THAT instance's `.open`, not a new
  // `createSettingsPanel()` or `connectSettings()` call of its own.
  const createSidebarCalls = (BOOT_NO_COMMENTS.match(/createSidebar\(\{/g) ?? []).length;
  assert.equal(createSidebarCalls, 1, 'expected exactly one createSidebar call');

  const connectSettingsCalls = (BOOT_NO_COMMENTS.match(/connectSettings\(/g) ?? []).length;
  assert.equal(
    connectSettingsCalls,
    1,
    'a second connectSettings() call would mean a second settings UI — exactly ' +
      'what the configSchema rule exists to prevent'
  );

  const sidebarAt = BOOT_NO_COMMENTS.indexOf('createSidebar({');
  assert.ok(sidebarAt >= 0, 'could not locate the createSidebar call');

  // The call's own closing, found by brace depth so this does not depend on
  // guessing how many options are passed.
  const openAt = BOOT_NO_COMMENTS.indexOf('{', sidebarAt);
  let depth = 0;
  let closeAt = -1;
  for (let i = openAt; i < BOOT_NO_COMMENTS.length; i++) {
    if (BOOT_NO_COMMENTS[i] === '{') depth++;
    else if (BOOT_NO_COMMENTS[i] === '}') {
      depth--;
      if (depth === 0) {
        closeAt = i;
        break;
      }
    }
  }
  assert.ok(closeAt > openAt, 'could not find the end of the createSidebar call');

  const callBody = BOOT_NO_COMMENTS.slice(openAt, closeAt);
  assert.match(
    callBody,
    /onSettings:\s*\(id\)\s*=>\s*settingsPanel\.open\(id\)/,
    'createSidebar must be given an onSettings that opens the EXISTING settingsPanel'
  );
});

test('a sidebar instance is added to the shared roster, or its settings save silently no-ops', () => {
  // `connectSettings`'s onSaved persists through `persist(widgetId, config)`,
  // which looks the widget up in the shared `roster` Map and returns early —
  // with nothing thrown and nothing logged — if it is not there. That map was
  // only ever seeded from the GRID's reconciled entries before this change, so
  // a sidebar widget's gear would open the form, validate it and update the
  // host in place, and then the save would vanish: the database row would
  // never change, and a reload would show the old config back.
  const loopAt = BOOT_NO_COMMENTS.indexOf('for (const entry of sidebarEntries)');
  assert.ok(loopAt >= 0, 'could not locate the sidebar boot loop');

  const openAt = BOOT_NO_COMMENTS.indexOf('{', loopAt);
  let depth = 0;
  let closeAt = -1;
  for (let i = openAt; i < BOOT_NO_COMMENTS.length; i++) {
    if (BOOT_NO_COMMENTS[i] === '{') depth++;
    else if (BOOT_NO_COMMENTS[i] === '}') {
      depth--;
      if (depth === 0) {
        closeAt = i;
        break;
      }
    }
  }
  assert.ok(closeAt > openAt, 'could not find the end of the sidebar boot loop');

  const loopBody = BOOT_NO_COMMENTS.slice(openAt, closeAt);
  assert.match(
    loopBody,
    /roster\.set\(\s*entry\.id/,
    'the sidebar boot loop must add its mounted entries to the shared roster, ' +
      'or persist() finds nothing and a sidebar settings save is silently dropped'
  );
});

test('persist() reconciles a sidebar entry against the live sortOrder before saving', () => {
  // `sidebarZone.move` renumbers through `renumber()` in sidebar-zone.js,
  // which deliberately returns a NEW entry object (so Discard's snapshot is
  // never mutated out from under it) rather than updating the one `roster`
  // holds. Left alone, `roster`'s copy of a moved sidebar card goes stale:
  // opening its settings and saving would write the config through with
  // whatever `sortOrder` it had BEFORE the move, undoing the reorder the next
  // time the layout loads.
  const fnAt = BOOT_NO_COMMENTS.indexOf('async function persist(');
  assert.ok(fnAt >= 0, 'could not locate persist()');

  const openAt = BOOT_NO_COMMENTS.indexOf('{', fnAt);
  let depth = 0;
  let closeAt = -1;
  for (let i = openAt; i < BOOT_NO_COMMENTS.length; i++) {
    if (BOOT_NO_COMMENTS[i] === '{') depth++;
    else if (BOOT_NO_COMMENTS[i] === '}') {
      depth--;
      if (depth === 0) {
        closeAt = i;
        break;
      }
    }
  }
  assert.ok(closeAt > openAt, 'could not find the end of persist()');

  const fnBody = BOOT_NO_COMMENTS.slice(openAt, closeAt);
  assert.match(
    fnBody,
    /sidebarZone\?\.\s*entries/,
    'persist() must read the live sidebarZone entries rather than trusting its ' +
      "own roster copy — otherwise a reorder's sortOrder can be overwritten by " +
      'a stale settings save'
  );
});

test('the sidebar boot loop starts the clock for a clock entry, same as the grid loop', () => {
  // The grid boot loop calls `startClock(host)` for every `type === 'clock'`
  // entry after `dashboard.add`/`grid.load` — the clock's tick is a
  // host-owned scheduler task (see `startClockTicks` in `clock-source.js`)
  // that never runs unless something explicitly starts it. The sidebar boot
  // loop mounts its entries through `dashboard.add` too, but historically
  // never made the same call: a clock added live via the add panel ticks
  // (that call site does `startClock`), but the SAME clock stops ticking
  // after a reload, because the boot-time sidebar loop skipped it.
  //
  // Sliced to the sidebar boot loop specifically (`for (const entry of
  // sidebarEntries)`), so a `startClock` call anywhere else in the file —
  // e.g. the grid loop just above it — cannot satisfy this.
  const loopAt = BOOT_NO_COMMENTS.indexOf('for (const entry of sidebarEntries)');
  assert.ok(loopAt >= 0, 'could not locate the sidebar boot loop');

  // The loop's own closing brace: found by scanning forward and tracking
  // brace depth from the loop's opening `{`, so this does not depend on
  // guessing how many statements are inside it.
  const openAt = BOOT_NO_COMMENTS.indexOf('{', loopAt);
  let depth = 0;
  let closeAt = -1;
  for (let i = openAt; i < BOOT_NO_COMMENTS.length; i++) {
    if (BOOT_NO_COMMENTS[i] === '{') depth++;
    else if (BOOT_NO_COMMENTS[i] === '}') {
      depth--;
      if (depth === 0) {
        closeAt = i;
        break;
      }
    }
  }
  assert.ok(closeAt > openAt, 'could not find the end of the sidebar boot loop');

  const loopBody = BOOT_NO_COMMENTS.slice(openAt, closeAt);
  assert.match(
    loopBody,
    /entry\.type === 'clock'/,
    "the sidebar boot loop never checks for type === 'clock', so a reloaded " +
      'sidebar clock is never started'
  );
  assert.match(
    loopBody,
    /startClock\(/,
    'the sidebar boot loop must call startClock, mirroring the grid loop, or a ' +
      'sidebar clock stops ticking after every reload'
  );
});
