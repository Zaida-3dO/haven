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
