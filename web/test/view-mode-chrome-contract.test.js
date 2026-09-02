import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * Stylesheet contracts for the view-mode chrome.
 *
 * -- Why these are source scans and not rendering assertions ---------------
 * Every bug below was live while the unit suite was green, and each was green
 * for the same reason: the fake DOM these tests run against has no layout
 * engine, no computed styles and no UA stylesheet. It cannot observe that an
 * element with `hidden === true` is nevertheless painted. The DOM was correct
 * in all three cases; the STYLESHEET was not.
 *
 * ## The `[hidden]` specificity trap -- hit three times in this repo
 *
 * `hidden` is implemented by the UA stylesheet as `display: none`, at UA
 * specificity, which ANY author `display` declaration beats. So a rule like
 * `.haven-toolbar { display: flex }` silently re-shows every element the code
 * has carefully marked hidden.
 *
 * It hit the apps widget secondary-URL menu first: every card rendered its
 * URLs unprompted under a toggle that claimed to be collapsed. It hit the
 * edit toolbar next -- `bar.hidden = true` was set, the accessibility tree was
 * right, `toolbar.el.hidden` asserted true in the unit tests, and the
 * "Edit dashboard" button went on rendering at the top-left of the page,
 * which was the single thing that change set out to remove. A browser found
 * it in one screenshot; 906 unit tests did not.
 *
 * Any element hidden via the `hidden` property AND given a `display` in the
 * stylesheet needs a matching `[hidden] { display: none }`. That is the
 * invariant asserted here.
 */

const CSS = readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8');
const APPS_STYLES = readFileSync(new URL('../src/widgets/apps/styles.js', import.meta.url), 'utf8');

/** Strips comments so a rule quoted in prose cannot satisfy a check. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const CSS_RULES = stripComments(CSS);
const APPS_RULES = stripComments(APPS_STYLES);

/**
 * The declaration block for a selector, or null.
 *
 * Anchored so `.haven-toolbar` is not satisfied by `.haven-toolbar__save`,
 * which is a different element.
 */
function ruleFor(selector, source = CSS_RULES) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(String.raw`(^|[},])\s*${escaped}\s*\{([^}]*)\}`, 'm').exec(source);
  return match ? match[2] : null;
}

test('the stylesheets are actually being read', () => {
  // A scan over an empty or mis-pathed file passes vacuously, which is the
  // failure mode that makes a guard like this worthless.
  assert.ok(CSS.length > 1000, `expected to read main.css, got ${CSS.length} characters`);
  assert.ok(
    APPS_STYLES.length > 1000,
    `expected to read the apps widget styles, got ${APPS_STYLES.length} characters`
  );
  assert.ok(ruleFor('.haven-sidebar'), 'expected to find the .haven-sidebar rule');
});

/* -- 1. No section headers in view mode --------------------------------- */

test('the widget handle is hidden by default -- no title bars in view mode', () => {
  const rule = ruleFor('.haven-widget__handle');

  assert.ok(rule, 'main.css has no `.haven-widget__handle` rule at all');
  assert.match(
    rule,
    /display\s*:\s*none/,
    'The widget handle must be `display: none` by default. It is the tile title ' +
      'bar ("HERO", "APPS", "CLOCK"), and the dashboard Haven replaces has none of ' +
      'these on its main grid. Anything other than `none` puts them all back. ' +
      `Found: ${rule}`
  );
});

test('the widget handle comes BACK in edit mode, where it is the drag handle', () => {
  // The rule above is only correct because edit mode re-shows it. Without
  // this half, the fix would have silently removed the drag handle, the
  // settings gear and the remove button along with the title.
  const rule = ruleFor('.haven-grid--edit-mode .haven-widget__handle');

  assert.ok(
    rule,
    'Nothing re-shows `.haven-widget__handle` in edit mode. The handle carries the ' +
      'drag affordance and the settings/remove controls, so hiding it in view mode ' +
      'without restoring it in edit mode makes the dashboard uneditable.'
  );
  assert.match(rule, /display\s*:\s*flex/, `expected edit mode to restore it, found: ${rule}`);
});

/* -- 2. The edit toolbar is not prominent -------------------------------- */

test('a hidden edit toolbar is actually hidden -- the [hidden] specificity trap', () => {
  const base = ruleFor('.haven-toolbar');
  assert.ok(base, 'main.css has no `.haven-toolbar` rule');

  // The trap only exists because the base rule declares a `display`. If it
  // ever stops doing so, this test should say why it is now unnecessary
  // rather than passing vacuously.
  assert.match(
    base,
    /display\s*:/,
    '`.haven-toolbar` no longer declares a `display`, so the UA `[hidden]` rule ' +
      'would win on its own. If that is deliberate, this test can go -- but check ' +
      'first, because the assertion below is now vacuous.'
  );

  const hiddenRule = ruleFor('.haven-toolbar[hidden]');
  assert.ok(
    hiddenRule,
    'main.css has no `.haven-toolbar[hidden]` rule. `hidden` is a UA-stylesheet ' +
      '`display: none`, which the author `display: flex` above beats -- so ' +
      '`bar.hidden = true` sets the attribute, passes every unit test that asserts ' +
      'the property, and the "Edit dashboard" button goes on rendering at the ' +
      'top-left of the page anyway.'
  );
  assert.match(hiddenRule, /display\s*:\s*none/, `expected display:none, found: ${hiddenRule}`);
});

test('a closed profile dropdown is actually closed -- the same trap', () => {
  const base = ruleFor('.haven-profile__menu');
  assert.ok(base, 'main.css has no `.haven-profile__menu` rule');
  assert.match(
    base,
    /display\s*:/,
    '`.haven-profile__menu` no longer declares a `display`; see the note in the ' +
      'toolbar test above before deleting the assertion below.'
  );

  const hiddenRule = ruleFor('.haven-profile__menu[hidden]');
  assert.ok(
    hiddenRule,
    'main.css has no `.haven-profile__menu[hidden]` rule. The menu is hidden with ' +
      'the `hidden` property, and the author `display: flex` above beats the UA ' +
      'stylesheet -- so the dropdown would render permanently open under the header.'
  );
  assert.match(hiddenRule, /display\s*:\s*none/, `expected display:none, found: ${hiddenRule}`);
});

/* -- 3. The card kebab menu ---------------------------------------------- */

test('a closed card menu is actually closed -- the trap that was hit first', () => {
  const base = ruleFor('.menu__list', APPS_RULES);
  assert.ok(base, 'the apps widget styles have no `.menu__list` rule');
  assert.match(
    base,
    /display\s*:/,
    '`.menu__list` no longer declares a `display`; see the toolbar test above.'
  );

  const hiddenRule = ruleFor('.menu__list[hidden]', APPS_RULES);
  assert.ok(
    hiddenRule,
    'the apps widget styles have no `.menu__list[hidden]` rule. This is the ' +
      'original instance of the trap: every card rendered its secondary URLs ' +
      'unprompted under a toggle that claimed to be collapsed.'
  );
  assert.match(hiddenRule, /display\s*:\s*none/, `expected display:none, found: ${hiddenRule}`);
});

test('the kebab button sits above the stretched card link', () => {
  // `.card__name::after` covers the entire card as a click target. Anything
  // interactive on the card must be layered above it or it cannot be clicked
  // at all -- the overlay eats the pointer and the whole menu is dead.
  const rule = ruleFor('.menu', APPS_RULES);

  assert.ok(rule, 'the apps widget styles have no `.menu` rule');
  assert.match(
    rule,
    /position\s*:\s*relative/,
    `a z-index only applies to a positioned element, found: ${rule}`
  );
  assert.match(
    rule,
    /z-index\s*:\s*[1-9]/,
    'The kebab menu must be layered above `.card__name::after`, the stretched link ' +
      'overlay that covers the whole card. Without a z-index the button is ' +
      'underneath a transparent anchor and clicking it navigates to the app instead ' +
      `of opening the menu. Found: ${rule}`
  );
});

/* -- 4. The sidebar ------------------------------------------------------ */

test('the layout gives the sidebar a fixed column and the grid the rest', () => {
  const rule = ruleFor('.haven-layout');

  assert.ok(rule, 'main.css has no `.haven-layout` rule');
  assert.match(rule, /display\s*:\s*grid/, `expected a grid layout, found: ${rule}`);
  assert.match(
    rule,
    /grid-template-columns\s*:\s*1fr\s+var\(--haven-sidebar-width\)/,
    `expected 1fr var(--haven-sidebar-width), found: ${rule}`
  );
});

test('the grid column may be narrower than its content', () => {
  // A grid item default `min-width` is `auto` -- "as wide as my contents
  // demand". Without this override a wide app grid pushes the whole layout
  // wider than the viewport and shoves the sidebar off the right edge, which
  // is a layout that looks fine until the grid gets dense.
  const rule = ruleFor('.haven-layout > #haven-chrome');

  assert.ok(
    rule,
    'main.css does not override `min-width` on the grid column. A grid item ' +
      'defaults to `min-width: auto`, so the `1fr` track cannot actually shrink ' +
      'to the space that is left and the sidebar gets pushed off screen.'
  );
  assert.match(rule, /min-width\s*:\s*0/, `expected min-width:0, found: ${rule}`);
});

test('the status card is pinned to the bottom of the sidebar', () => {
  const rule = ruleFor('.haven-sidebar__card--pinned');

  assert.ok(rule, 'main.css has no `.haven-sidebar__card--pinned` rule');
  assert.match(
    rule,
    /margin-top\s*:\s*auto/,
    'The status card is pinned to the bottom, matching the live dashboard. An ' +
      '`auto` top margin in a flex column consumes the free space above it; ' +
      `anything else lets it float up under the calendar. Found: ${rule}`
  );
});

test('the sidebar is a flex column, or nothing can be pinned to its bottom', () => {
  // `margin-top: auto` only does anything inside a flex (or grid) container.
  // If the sidebar ever became a plain block, the pin above would silently
  // stop working while still looking correct in the source.
  const rule = ruleFor('.haven-sidebar');

  assert.ok(rule, 'main.css has no `.haven-sidebar` rule');
  assert.match(rule, /display\s*:\s*flex/, `expected a flex container, found: ${rule}`);
  assert.match(rule, /flex-direction\s*:\s*column/, `expected a column, found: ${rule}`);
});

test('the sidebar stacks below 1024px instead of squeezing the grid', () => {
  // A 320px fixed track on a tablet leaves the app grid too narrow to use.
  const media = /@media\s*\(max-width:\s*1024px\)\s*\{([\s\S]*?)\n\}/.exec(CSS_RULES);

  assert.ok(media, 'main.css has no `@media (max-width: 1024px)` block for the sidebar');
  assert.match(
    media[1],
    /grid-template-columns\s*:\s*1fr\s*;/,
    `expected the layout to collapse to one column, found: ${media[1]}`
  );
});

test('sidebar titles carry an 18px icon', () => {
  const rule = ruleFor('.haven-sidebar__title svg');

  assert.ok(rule, 'main.css has no `.haven-sidebar__title svg` rule');
  assert.match(rule, /width\s*:\s*18px/, `expected an 18px icon, found: ${rule}`);
  assert.match(rule, /height\s*:\s*18px/, `expected an 18px icon, found: ${rule}`);
});
