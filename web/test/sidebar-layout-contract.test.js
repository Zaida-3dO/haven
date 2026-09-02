import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SIDEBAR_ICONS, createSidebar } from '../src/shell/sidebar.js';
import { createFakeDocument } from './helpers/fake-dom.js';

/**
 * The full-height, non-scrolling sidebar — and the 3D home card in it.
 *
 * ── Why this is a stylesheet contract ────────────────────────────────────
 * "Server Status is visible without scrolling" is a statement about a layout
 * engine, and the fake DOM these tests run against has none: no viewport, no
 * `getBoundingClientRect` that means anything, no scrollports, no computed
 * styles. It cannot tell a pinned sidebar from a scrolling one, because in
 * the fake DOM both are the same tree.
 *
 * So the invariant is asserted where it lives — in the cascade. Each test
 * below names the specific way the layout breaks if its rule is missing,
 * because "there is a rule" is not the claim; "this rule is what stops X" is.
 */

const CSS = readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8');
const CSS_RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

function ruleFor(selector, source = CSS_RULES) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(String.raw`(^|[},])\s*${escaped}\s*\{([^}]*)\}`, 'm').exec(source);
  return match ? match[2] : null;
}

/** The `@media (max-width: 1024px)` block's body — where the sidebar unstacks. */
function mobileBlock() {
  const match = /@media\s*\(max-width:\s*1024px\)\s*\{([\s\S]*?)\n\}/.exec(CSS_RULES);
  return match ? match[1] : null;
}

test('the stylesheet is actually being read', () => {
  // A scan over an empty or mis-pathed file passes vacuously, which is the
  // failure mode that makes every check below worthless.
  assert.ok(CSS.length > 1000, `expected to read main.css, got ${CSS.length} characters`);
  assert.ok(ruleFor('.haven-layout'), 'expected to find the .haven-layout rule');
  assert.ok(mobileBlock(), 'expected to find the 1024px media block');
});

/* ── 1. The layout is pinned to the viewport ───────────────────────────── */

test('the layout is exactly the viewport height, not merely AT LEAST it', () => {
  // This is the whole change, in one declaration. `min-height` lets the
  // layout grow with a tall app grid, which makes the DOCUMENT the scrollport
  // — and a document that scrolls carries the sidebar up and off the screen
  // with it, taking the pinned Server Status card with it. `height` fixes the
  // row to the space under the header so the sidebar has a bottom to pin to.
  const rule = ruleFor('.haven-layout');

  assert.ok(rule, 'main.css has no `.haven-layout` rule');
  assert.match(
    rule,
    /(^|[;{\s])height\s*:\s*calc\(\s*100vh\s*-\s*var\(--haven-header-height\)\s*\)/,
    'the layout must be `height: calc(100vh - var(--haven-header-height))`. With ' +
      '`min-height` instead, a tall grid grows the layout, the PAGE scrolls, and ' +
      `the sidebar scrolls away with it. Found: ${rule}`
  );
});

test('the layout clips rather than stretching to its content', () => {
  // The other half of the pin. Without `overflow: hidden` a grid taller than
  // the fixed height would simply overflow the box and paint outside it —
  // the layout would be the right height and the content would ignore it.
  const rule = ruleFor('.haven-layout');
  assert.match(rule, /overflow\s*:\s*hidden/, `expected overflow:hidden, found: ${rule}`);
});

test('the MAIN column is the scrollport, and it is the only one', () => {
  // Where the scrolling moved TO. If this is missing the layout is pinned and
  // nothing scrolls at all: the bottom of a long app grid becomes permanently
  // unreachable, which is a strictly worse bug than the one being fixed.
  const rule = ruleFor('.haven-layout > #haven-chrome');

  assert.ok(rule, 'main.css has no `.haven-layout > #haven-chrome` rule');
  assert.match(
    rule,
    /overflow-y\s*:\s*auto/,
    'the grid column must scroll internally. Without it the layout is pinned to ' +
      `the viewport and a long app grid is simply cut off. Found: ${rule}`
  );
});

test('the grid column may be SHORTER than its content, or it never scrolls', () => {
  // The trap that makes the rule above a no-op. A grid item's default
  // `min-height` is `auto` — "as tall as my contents demand" — so the column
  // grows to fit the grid, the `overflow-y: auto` box is never smaller than
  // what is inside it, and the scrollbar never appears. Exactly the same trap
  // as `min-width: auto` on the other axis, which this file's sibling rule
  // already documents.
  const rule = ruleFor('.haven-layout > #haven-chrome');

  assert.match(
    rule,
    /min-height\s*:\s*0/,
    'the grid column needs `min-height: 0`. A grid item defaults to ' +
      '`min-height: auto`, so it stretches to its content and `overflow-y: auto` ' +
      `never has anything to scroll. Found: ${rule}`
  );
});

test('the min-WIDTH override survives — the sidebar must not be pushed off', () => {
  // Anti-regression, not new: the width half was already load-bearing and
  // lives in the same rule the height half was just added to, so an edit to
  // one is an opportunity to drop the other.
  const rule = ruleFor('.haven-layout > #haven-chrome');
  assert.match(rule, /min-width\s*:\s*0/, `expected min-width:0 to survive, found: ${rule}`);
});

test('the header includes its border in the height the layout subtracts', () => {
  // A real bug, found in a browser and not by any of the scans above.
  //
  // The layout is sized `calc(100vh - var(--haven-header-height))`, which is
  // only correct if the header is EXACTLY that tall. There is no global
  // `box-sizing: border-box` reset in this stylesheet, so the header defaulted
  // to `content-box`: 70px of content PLUS a 1px bottom border, 71px on
  // screen. 71 + (100vh - 70) = 100vh + 1px, so the page scrolled by exactly
  // one pixel — enough to raise a scrollbar and to push the bottom-pinned
  // Server Status card one pixel below the fold, which is the single thing
  // this whole layout exists to prevent.
  //
  // Measured before the fix: `document.scrollHeight` 901 against a 900px
  // viewport. After: 900, and `docScrolls` false.
  const rule = ruleFor('.haven-header');

  assert.ok(rule, 'main.css has no `.haven-header` rule');
  assert.match(
    rule,
    /height\s*:\s*var\(--haven-header-height\)/,
    `the header must be exactly the variable the layout subtracts, found: ${rule}`
  );
  assert.match(
    rule,
    /border-bottom\s*:/,
    'the header no longer has a bottom border. If that is deliberate the ' +
      '`box-sizing` below is no longer load-bearing — but check, because the ' +
      'assertion after this one becomes vacuous.'
  );
  assert.match(
    rule,
    /box-sizing\s*:\s*border-box/,
    'the header declares a `height` AND a `border-bottom`, so without ' +
      '`box-sizing: border-box` it renders 1px taller than the height the layout ' +
      `subtracts, and the page scrolls by exactly that pixel. Found: ${rule}`
  );
});

test('there is still no global border-box reset to make that redundant', () => {
  // Anti-vacuity for the test above, and a genuine fork in the road. If a
  // global `*, *::before, *::after { box-sizing: border-box }` is ever added,
  // the header-scoped declaration becomes redundant and this pair of tests
  // should be replaced by one asserting the global reset. Until then the
  // scoped fix is the whole defence, and it must not be deleted as noise.
  const universal = /\*\s*,?[^{]*\{[^}]*box-sizing\s*:\s*border-box/.test(CSS_RULES);
  assert.ok(
    !universal,
    'a global `box-sizing: border-box` reset has been added. That makes the ' +
      'header-scoped declaration redundant — fold these two tests into one that ' +
      'asserts the global reset instead, rather than deleting the coverage.'
  );
});

/* ── 2. The sidebar itself does not scroll ─────────────────────────────── */

test('the sidebar does not scroll internally either', () => {
  // The subtle failure this catches. With the layout pinned, a sidebar with
  // `overflow-y: auto` LOOKS correct — it is full height and it fits — but
  // the pinned Server Status card sits below the fold of its own private
  // scrollport, so it is hidden exactly as effectively as a scrolling page
  // hid it. The requirement is "visible without scrolling", not "reachable".
  const rule = ruleFor('.haven-sidebar');

  assert.ok(rule, 'main.css has no `.haven-sidebar` rule');
  assert.match(
    rule,
    /overflow\s*:\s*hidden/,
    'the sidebar must not become its own scrollport — that hides the pinned ' +
      `status card just as effectively as a scrolling page did. Found: ${rule}`
  );
  assert.match(
    rule,
    /min-height\s*:\s*0/,
    `a grid item defaults to min-height:auto and would stretch the row, found: ${rule}`
  );
});

test('the sidebar is still a flex column with the status card pinned', () => {
  // Anti-vacuity for everything above. Making the layout full-height only
  // achieves the goal because `margin-top: auto` pushes the status card to
  // the bottom of that height. If the pin went away, the sidebar would be
  // full-height with the status card floating directly under the 3D home and
  // a large blank gap below it — and every test above would still pass.
  const sidebar = ruleFor('.haven-sidebar');
  assert.match(sidebar, /display\s*:\s*flex/, `expected a flex container, found: ${sidebar}`);
  assert.match(sidebar, /flex-direction\s*:\s*column/, `expected a column, found: ${sidebar}`);

  const pinned = ruleFor('.haven-sidebar__card--pinned');
  assert.ok(pinned, 'main.css has no `.haven-sidebar__card--pinned` rule');
  assert.match(
    pinned,
    /margin-top\s*:\s*auto/,
    `the status card must still be pinned to the bottom, found: ${pinned}`
  );
});

/* ── 3. Mobile goes back to a normal document flow ─────────────────────── */

test('below 1024px the layout is free to grow again', () => {
  // A pinned full-height layout on a phone is wrong twice over: stacked, the
  // two columns are taller than the viewport BY DEFINITION, so `height:
  // 100vh` + `overflow: hidden` would clip the sidebar off the bottom of the
  // page with no way to reach it at all. The document must scroll again.
  const mobile = mobileBlock();

  assert.match(
    mobile,
    /height\s*:\s*auto/,
    'the 1024px block must reset the layout `height` to `auto`. Stacked, the ' +
      'columns are taller than the viewport, so a fixed height clips the sidebar ' +
      `off the bottom with nothing able to scroll to it. Found: ${mobile}`
  );
  assert.match(
    mobile,
    /overflow\s*:\s*visible/,
    `the 1024px block must reset the layout overflow, found: ${mobile}`
  );
});

test('below 1024px the main column stops being a scrollport', () => {
  // Two nested scrollports on a phone is the "scroll trap": the page scrolls,
  // then the inner column scrolls, and a touch drag does whichever one the
  // browser guesses. The document must be the only scroller.
  const mobile = mobileBlock();
  assert.match(
    mobile,
    /overflow-y\s*:\s*visible/,
    `the grid column must stop scrolling internally below 1024px, found: ${mobile}`
  );
});

test('below 1024px the sidebar still stacks into one column', () => {
  // Anti-regression: the stacking is what makes all of the above necessary,
  // and it predates this change.
  const mobile = mobileBlock();
  assert.match(
    mobile,
    /grid-template-columns\s*:\s*1fr\s*;/,
    `expected the layout to collapse to one column, found: ${mobile}`
  );
});

test('the mobile resets come AFTER the desktop rules they override', () => {
  // A media query adds no specificity. `@media (max-width: 1024px)` and the
  // unconditioned `.haven-layout` rule are equally specific, so source order
  // is the ONLY thing deciding which wins — and if the media block were ever
  // moved above the layout rules, the phone would silently get the pinned
  // desktop layout back with no test failing.
  const layoutAt = CSS_RULES.indexOf('.haven-layout {');
  const columnAt = CSS_RULES.indexOf('.haven-layout > #haven-chrome {');
  const mobileAt = CSS_RULES.indexOf('@media (max-width: 1024px)');

  assert.ok(layoutAt >= 0 && columnAt >= 0 && mobileAt >= 0, 'expected all three rules');
  assert.ok(mobileAt > layoutAt, 'the 1024px block must come after `.haven-layout`');
  assert.ok(mobileAt > columnAt, 'the 1024px block must come after the grid-column rule');
});

/* ── 4. The 3D home card ───────────────────────────────────────────────── */

test('the 3D home card body has an explicit height', () => {
  // The `percentage-height-contract` trap, arriving in a new place. The
  // iframe widget sets `:host { height: 100% }`, and a percentage height
  // resolves against the parent. A sidebar card body is `height: auto` — its
  // height comes from its children — so the percentage resolves to zero and
  // the 3D home renders its scene correctly into a 0px box. Nothing throws,
  // nothing is missing from the DOM, the card just looks empty.
  const rule = ruleFor('.haven-sidebar__card--home3d .haven-sidebar__body');

  assert.ok(
    rule,
    'main.css gives the 3D home card body no height. The iframe widget sizes ' +
      'itself with `:host { height: 100% }`, which resolves against a parent whose ' +
      'height is `auto` — so it computes to 0 and the card renders empty.'
  );
  assert.match(rule, /height\s*:\s*\d+px/, `expected an explicit pixel height, found: ${rule}`);
});

test('the 3D home widget really does need that height', () => {
  // Anti-vacuity for the rule above: it is only load-bearing while the iframe
  // widget sizes itself to its container. If it ever stopped, the rule would
  // look like an arbitrary magic number and be a candidate for deletion.
  const iframe = readFileSync(new URL('../src/widgets/iframe/element.js', import.meta.url), 'utf8');
  assert.match(
    iframe,
    /:host\s*\{[^}]*height\s*:\s*100%/,
    'the iframe widget no longer uses `:host { height: 100% }`. If that is ' +
      'deliberate, the fixed height on the 3D home card can go with it — but not ' +
      'the height on its own, and check the card still renders first.'
  );
});

test('the sidebar emits a per-card modifier class the stylesheet can target', () => {
  // The rule above selects `.haven-sidebar__card--home3d`. If the sidebar
  // stopped emitting that class the CSS would be dead and the card would
  // collapse to 0px again — with the stylesheet scan above still passing,
  // because the rule would still be there.
  const doc = createFakeDocument();
  const sidebar = createSidebar({
    cards: [{ id: 'home3d', title: '3D Home', icon: 'home3d' }],
    document: doc,
  });

  const card = sidebar.cards.get('home3d');
  assert.ok(card, 'the sidebar built no card for id "home3d"');
  assert.ok(
    card.el.className.includes('haven-sidebar__card--home3d'),
    `expected a per-id modifier class, got "${card.el.className}"`
  );
});

test('the sidebar has an icon for the 3D home card', () => {
  // A card whose icon key is not in `SIDEBAR_ICONS` renders its title with no
  // icon and no error — it would just quietly look different from the other
  // three, which is the kind of thing only a screenshot catches.
  assert.ok(
    Array.isArray(SIDEBAR_ICONS.home3d) && SIDEBAR_ICONS.home3d.length > 0,
    'SIDEBAR_ICONS has no `home3d` entry, so the card renders with a bare title'
  );
});

/* ── 5. The 3D home moved OFF the grid, and only moved ─────────────────── */

const BOOT_SRC = readFileSync(new URL('../src/shell/boot.js', import.meta.url), 'utf8');
const BOOT_CODE = BOOT_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('the 3D home is a SIDEBAR instance', () => {
  assert.match(
    BOOT_CODE,
    /card:\s*'home3d'/,
    'no sidebar instance is mounted into the home3d card, so the card renders empty'
  );
  assert.match(
    BOOT_CODE,
    /card:\s*'home3d',[\s\S]{0,120}type:\s*'iframe'/,
    'the home3d sidebar card is not wired to the iframe widget'
  );
});

test('the 3D home is NOT also on the main grid', () => {
  // The failure this catches is not "it is missing" but "it is in both
  // places": the grid roster entry left behind would mount a SECOND copy of
  // the embed, loading the 3D scene twice — once visibly in the sidebar and
  // once again in a grid tile. Comments are stripped first, so the note in
  // `FALLBACK_INSTANCES` explaining the absence cannot satisfy this.
  assert.ok(
    !/id:\s*'embed-home3d'/.test(BOOT_CODE),
    'the grid fallback roster still contains `embed-home3d`. It has moved to the ' +
      'sidebar, so leaving it here mounts the 3D home twice.'
  );
});

test('the sidebar order is weather · calendar · 3D home · status', () => {
  // Order is the requirement, not just membership: the 3D home goes BETWEEN
  // calendar and status, and status stays last because it is the pinned card.
  // Scoped to the `cards:` array specifically. A bare scan of the whole file
  // also picks up `SIDEBAR_INSTANCES`, which declares the same four ids in
  // the same order for a different purpose — so it would report a plausible
  // eight-entry sequence and be asserting something other than card order.
  const cards = /cards:\s*\[([\s\S]*?)\]/.exec(BOOT_CODE);
  assert.ok(cards, 'could not find the `cards:` array passed to createSidebar');

  const ids = [...cards[1].matchAll(/id:\s*'([a-z0-9]+)'/g)].map((m) => m[1]);

  assert.deepEqual(
    ids,
    ['weather', 'calendar', 'home3d', 'status'],
    `the sidebar cards are declared in the wrong order: ${ids.join(' · ')}`
  );
});

test('the status card is still the pinned one', () => {
  assert.match(
    BOOT_CODE,
    /id:\s*'status',[\s\S]{0,80}pinned:\s*true/,
    'Server Status must stay pinned to the bottom — inserting the 3D home above it ' +
      'is only correct while the pin still holds status at the end'
  );
  assert.ok(
    !/id:\s*'home3d',[\s\S]{0,80}pinned:\s*true/.test(BOOT_CODE),
    'the 3D home must not be pinned; only one card can hold the bottom'
  );
});

test('the 3D home embed keeps its locked-down sandbox', () => {
  // It kept the same config when it moved. A move is not the place to widen
  // an iframe sandbox, and `allowSameOrigin: 'yes'` would let the embed read
  // this dashboard.
  const entry = /card:\s*'home3d',[\s\S]{0,400}?\},\s*\n/.exec(BOOT_CODE);
  assert.ok(entry, 'could not find the home3d sidebar instance');
  assert.match(entry[0], /allowSameOrigin:\s*'no'/, 'the embed must not get same-origin access');
  assert.match(entry[0], /allowForms:\s*'no'/, 'the embed must not get forms');
  assert.match(entry[0], /allowPopups:\s*'no'/, 'the embed must not get popups');
});

test('the 3D home URL is relative, never an internal address', () => {
  // A public repo must not carry network topology. The URL comes from
  // `HOME_3D_URL`, which is a relative path; a literal host here would be a
  // secrets-scan failure as well as a bug.
  assert.match(BOOT_CODE, /url:\s*HOME_3D_URL/, 'the embed URL must come from HOME_3D_URL');
});
