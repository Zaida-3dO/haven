import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * The gap between widgets is padding INSIDE the cell, never margin around it.
 *
 * ── What was asked for, and the distinction that matters ─────────────────
 * The request was for "a reasonable padding between the edges of the yellow
 * area and the actual widget content" — the yellow area being the dashed
 * outline edit mode draws on every tile, which IS the GridStack cell
 * boundary. Crucially, the outlines *touching* is correct: that is what a
 * grid looks like. The padding belongs within those bounds.
 *
 * There are two ways to put space between two widgets and they are not
 * interchangeable:
 *
 *  - GridStack's `margin` option, which drives `--gs-item-margin-*` and
 *    absolutely positions `.grid-stack-item-content` inset from the cell.
 *    That element IS `.haven-widget-tile` (see `createTile` in
 *    dashboard-grid.js) and IS what carries the dashed border, so a margin
 *    shrinks the OUTLINE away from the cell edge. Neighbouring outlines then
 *    float apart and the padding lands outside the outline rather than
 *    within it — the opposite of what was asked for.
 *  - Padding inside the tile, which leaves the outline flush with the cell
 *    and moves only the content. Both neighbours contribute, so the visible
 *    separation is twice the inset.
 *
 * The second is the contract. `margin` was 8 and is now 0.
 *
 * ── Why this is a source scan rather than a rendering assertion ───────────
 * Same reason as `percentage-height-contract`: the fake DOM these tests run
 * against has no layout engine, so nothing here can observe that two tiles
 * are 16px apart. A passing test is NOT evidence the padding renders — that
 * was checked in a real browser, where the tile measured inset {0,0,0,0}
 * against its cell with 8px of padding, and adjacent outlines shared an
 * edge exactly. What this test defends is the *decision*: that the spacing
 * stays inside the tile and does not migrate back to a grid margin.
 */

const CSS = readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8');
const GRID_JS = readFileSync(new URL('../src/shell/grid.js', import.meta.url), 'utf8');

/** Strips comments so a rule quoted in prose cannot satisfy a check. */
const CSS_RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const GRID_CODE = GRID_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * The declaration block for a selector, or null.
 *
 * Matches the selector on its own, so `.haven-widget-tile` cannot be
 * satisfied by `.haven-widget-tile--transparent` — a different element state
 * with deliberately different padding.
 */
function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(String.raw`(^|[},])\s*${escaped}\s*\{([^}]*)\}`, 'm').exec(CSS_RULES);
  return match ? match[2] : null;
}

test('the sources are actually being read', () => {
  // A scan over an empty or mis-pathed file passes vacuously, which is the
  // failure mode that makes a guard like this worthless.
  assert.ok(CSS.length > 1000, `expected to read main.css, got ${CSS.length} characters`);
  assert.ok(GRID_JS.length > 1000, `expected to read grid.js, got ${GRID_JS.length} characters`);
  assert.ok(ruleFor('.haven-widget__body'), 'expected to find the .haven-widget__body rule');
  assert.match(GRID_CODE, /mountGrid/, 'expected grid.js to define mountGrid');
});

test('the widget inset is defined as a design token', () => {
  assert.match(
    CSS_RULES,
    /--haven-widget-inset\s*:/,
    'The gap between widgets should be one named token, not a number repeated ' +
      'at each site that needs it.'
  );
});

test('the tile carries the inset as padding, inside its own border', () => {
  const rule = ruleFor('.haven-widget-tile');

  assert.ok(rule, 'main.css has no `.haven-widget-tile` rule — that is the tile element itself.');

  assert.match(
    rule,
    /padding\s*:\s*var\(\s*--haven-widget-inset\s*\)/,
    'The tile must carry the inter-widget gap as its own padding, so the dashed ' +
      'edit-mode outline stays flush with the grid cell and only the content moves ' +
      `in from it. Found: ${rule}`
  );
});

/**
 * The half that stops the overflow coming back.
 *
 * The tile is absolutely positioned by GridStack and given `height: 100%`.
 * This repo has no global `border-box` reset, so under the `content-box`
 * default the border is ADDED to that 100% and the tile renders taller than
 * the cell it lives in. That was real and measurable: every tile sat exactly
 * 10px past its cell's bottom edge before this change.
 */
test('the tile sizes its border and padding INTO its height', () => {
  const rule = ruleFor('.haven-widget-tile');

  assert.match(
    rule,
    /box-sizing\s*:\s*border-box/,
    'Without `box-sizing: border-box` the tile\'s border and padding are added to ' +
      'its `height: 100%`, so it overflows its own grid cell and overhangs the tile ' +
      `below. Found: ${rule}`
  );

  assert.match(
    rule,
    /height\s*:\s*100%/,
    `the tile is expected to fill its cell's height, found: ${rule}`
  );
});

/**
 * The rule that makes the inset a REDISTRIBUTION rather than an addition.
 *
 * A card's inner padding was 16px and should stay 16px. The tile now supplies
 * 8px of it, so the body supplies the remainder. Written as a subtraction so
 * the two cannot drift apart.
 */
test('a card\'s inner padding accounts for the tile inset instead of stacking on it', () => {
  const rule = ruleFor('.haven-widget__body');

  assert.match(
    rule,
    /padding\s*:\s*calc\(\s*var\(\s*--haven-space-4\s*\)\s*-\s*var\(\s*--haven-widget-inset\s*\)\s*\)/,
    'The body must subtract the tile inset from the card padding, or an opaque ' +
      `widget gains 8px it never had and its content sits 24px in. Found: ${rule}`
  );
});

/**
 * The transparent case, which is the one most likely to be "fixed" wrongly.
 *
 * Hero and apps default to transparent and have no card chrome in view mode.
 * Their BODY padding is zero — that is card padding and a full-bleed banner
 * should not have it. But the tile's inset must survive, because it is the
 * gap to the next widget rather than card padding, and it draws no box now
 * that the border, background and shadow are gone.
 */
test('a transparent widget drops its card padding but keeps the inter-widget gap', () => {
  const rule = ruleFor('.haven-widget-tile--transparent');

  assert.ok(rule, 'main.css has no `.haven-widget-tile--transparent` rule.');

  assert.doesNotMatch(
    rule,
    /padding\s*:/,
    'The transparent rule must NOT reset the tile\'s padding. That padding is the ' +
      'gap between one widget and the next, not card chrome — zeroing it leaves the ' +
      'hero and the apps grid running straight into their neighbours, and it ' +
      `reintroduces no visible box because this rule already removed one. Found: ${rule}`
  );

  const body = ruleFor('.haven-widget-tile--transparent .haven-widget__body');
  assert.match(
    body ?? '',
    /padding\s*:\s*0/,
    `a transparent widget's body drops the card padding so the hero stays full-bleed, found: ${body}`
  );
});

/**
 * The other side of the contract: the grid must NOT also space the cells.
 *
 * This is the assertion that actually encodes the request. If someone later
 * "adds a gap between widgets" the obvious way, this fails and says why.
 */
test('GridStack is mounted with no margin, so cells touch', () => {
  const defaulted = /margin\s*=\s*(\d+)/.exec(GRID_CODE);

  assert.ok(defaulted, 'expected `mountGrid` to still take a `margin` option with a default');

  assert.equal(
    defaulted[1],
    '0',
    'GridStack `margin` must stay 0. A non-zero margin insets the bordered tile ' +
      'within its cell, which pulls the dashed edit-mode outlines apart and puts ' +
      'the spacing OUTSIDE the outline — the spacing belongs inside it, as ' +
      '`--haven-widget-inset` padding on the tile.'
  );
});
