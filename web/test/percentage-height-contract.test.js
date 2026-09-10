import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

/**
 * A percentage height needs a parent with a resolved height.
 *
 * ── The bug this exists to catch ─────────────────────────────────────────
 * `WidgetHost.mount` creates the tile element — `div.haven-widget` — and every
 * widget's custom element is mounted inside its shadow root. That div had NO
 * rule in main.css at all, so it was `display: block` with `height: auto`:
 * its height came from its children.
 *
 * The hero's element sets `:host { height: 100% }`. A percentage height
 * resolves against the parent's height, and the parent's height was `auto`,
 * so the percentage had nothing to resolve against and computed to zero.
 * Parent waiting on child, child waiting on parent.
 *
 * The result was a hero that rendered a complete and correct carousel — right
 * slides, right image, right dots, measured in a real browser — into a box
 * 0px tall. No error, no exception, nothing missing from the DOM. Just a tile
 * that looked empty. Widgets whose content is intrinsically tall (the apps
 * grid) were unaffected, which is why exactly one widget appeared broken.
 *
 * ── Why this test is a source scan rather than a rendering assertion ──────
 * The fake DOM these tests run against has no layout engine: no
 * `getBoundingClientRect` that means anything, no computed styles, no
 * percentage resolution. It cannot observe a zero-height box, and no amount
 * of asserting on the hero's DOM would have caught this — the DOM was
 * correct. 900 tests passed against this bug for exactly that reason.
 *
 * So the invariant is asserted where it actually lives: the stylesheet. Any
 * widget element that sizes itself to its container needs the tile it is
 * mounted into to have a height to size against.
 */

const CSS = readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8');

/** Strips comments so a rule quoted in prose cannot satisfy a check. */
const CSS_RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The declaration block for a selector, or null.
 *
 * Deliberately matches the selector on its own — `.haven-widget` must not be
 * satisfied by `.haven-widget-tile` or `.haven-widget__body`, which are
 * different elements and were both already styled while the bug was live.
 */
function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(String.raw`(^|[},])\s*${escaped}\s*\{([^}]*)\}`, 'm').exec(CSS_RULES);
  return match ? match[2] : null;
}

test('the stylesheet is actually being read', () => {
  // A scan over an empty or mis-pathed file passes vacuously, which is the
  // failure mode that makes a guard like this worthless.
  assert.ok(CSS.length > 1000, `expected to read main.css, got ${CSS.length} characters`);
  assert.ok(ruleFor('.haven-widget__body'), 'expected to find the .haven-widget__body rule');
});

test('.haven-widget — the host tile — resolves a height for its widget', () => {
  const rule = ruleFor('.haven-widget');

  assert.ok(
    rule,
    'main.css has no `.haven-widget` rule. That element is what `WidgetHost.mount` ' +
      'creates and every widget is mounted inside it. Without a height it is `auto`, ' +
      'and a widget using `:host { height: 100% }` collapses to 0px — a fully ' +
      'rendered widget that paints nothing.'
  );

  assert.match(
    rule,
    /height\s*:\s*100%/,
    `.haven-widget must give its widget a height to resolve a percentage against, found: ${rule}`
  );
});

/** Every source file under web/src, recursively. */
function sources(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) sources(path, found);
    else if (entry.name.endsWith('.js')) found.push([path, readFileSync(path, 'utf8')]);
  }
  return found;
}

const files = sources(new URL('../src/', import.meta.url));

test('the source scan reaches the widget tree', () => {
  assert.ok(files.length > 20, `expected to scan the web source, found ${files.length} files`);
});

/**
 * The other half of the contract, and the reason this is not a one-line test.
 *
 * The rule above is only load-bearing because widgets really do use
 * `:host { height: 100% }`. If that ever stopped being true the rule would
 * look like dead CSS and be a candidate for deletion — reopening the bug. So
 * this asserts the dependency is real, and names the widgets that rely on it.
 */
test('at least one widget sizes itself with a percentage height on :host', () => {
  const dependants = files
    .filter(([, src]) => /:host\s*\{[^}]*height\s*:\s*100%/.test(src))
    .map(([url]) => url.pathname.split('/').slice(-2).join('/'));

  assert.ok(
    dependants.length > 0,
    'No widget uses `:host { height: 100% }` any more. If that is genuinely ' +
      'intended, this test and the `.haven-widget { height: 100% }` rule can go ' +
      'together — but not the rule on its own.'
  );

  // The hero is the widget the bug was found on; it must stay covered.
  assert.ok(
    dependants.some((path) => path.includes('hero')),
    `expected the hero element among the widgets sizing to their container, found: ${dependants.join(', ')}`
  );
});
