import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  TRANSPARENT_CLASS,
  TRANSPARENT_KEY,
  applyTransparent,
  isTransparent,
  transparentField,
} from '../src/shell/transparent.js';
import { heroWidget } from '../src/widgets/hero/definition.js';
import { appsWidgetDefinition } from '../src/widgets/apps/apps-widget.js';
import { applyDefaults, assertValidSchema } from '../src/shell/schema.js';

/**
 * The per-widget transparent-background option.
 *
 * ── Why the CSS half is a source scan ────────────────────────────────────
 * The same reason as `view-mode-chrome-contract.test.js` and
 * `percentage-height-contract.test.js`: the fake DOM has no layout engine, no
 * computed styles and no cascade. It cannot observe that a tile still paints
 * a border. Asserting the class lands on the element proves the JS; only a
 * stylesheet scan proves the class does anything, and only a scan of the
 * EDIT-MODE override proves it stops doing it when it must.
 *
 * The DOM half is real DOM assertions, because there the DOM is the artefact:
 * whether `applyTransparent` can turn the option back OFF is a fact about
 * `classList`, not about the cascade.
 */

const CSS = readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8');
const CSS_RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

function ruleFor(selector, source = CSS_RULES) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(String.raw`(^|[},])\s*${escaped}\s*\{([^}]*)\}`, 'm').exec(source);
  return match ? match[2] : null;
}

/** The fake DOM's classList stand-in, which is all `applyTransparent` needs. */
function fakeTile(className = '') {
  const tile = { className };
  tile.classList = {
    add: (...names) => {
      const present = tile.className.split(/\s+/).filter(Boolean);
      for (const n of names) if (!present.includes(n)) present.push(n);
      tile.className = present.join(' ');
    },
    remove: (...names) => {
      tile.className = tile.className
        .split(/\s+/)
        .filter((c) => c && !names.includes(c))
        .join(' ');
    },
    contains: (n) => tile.className.split(/\s+/).includes(n),
  };
  return tile;
}

test('the stylesheet is actually being read', () => {
  // A scan over an empty or mis-pathed file passes vacuously, which is the
  // failure mode that makes every check below worthless.
  assert.ok(CSS.length > 1000, `expected to read main.css, got ${CSS.length} characters`);
  assert.ok(ruleFor('.haven-widget-tile'), 'expected to find the .haven-widget-tile rule');
});

/* ── 1. The option is a real schema field ──────────────────────────────── */

test('the transparent field is a valid schema field', () => {
  // `assertValidSchema` is what the registry runs at registration, so a field
  // it rejects would take the whole widget down at boot.
  assert.doesNotThrow(() => assertValidSchema([transparentField(true)], 'test'));
});

test('the option is stored as a real boolean, not the string "true"', () => {
  // A `select` whose values were strings would put `'false'` in the config —
  // which is TRUTHY, so switching the option off would turn it on. The repo's
  // idiom (hero `showTagline`) uses real booleans and this must match it.
  const field = transparentField(true);
  const values = field.options.map((o) => o.value).sort();
  assert.deepEqual(
    values,
    [false, true],
    `expected real booleans as option values, got ${JSON.stringify(values)}`
  );
  assert.equal(typeof field.default, 'boolean', 'the default must be a boolean too');
});

test('isTransparent refuses a truthy non-boolean', () => {
  assert.equal(isTransparent({ [TRANSPARENT_KEY]: true }), true);
  assert.equal(isTransparent({ [TRANSPARENT_KEY]: false }), false);
  // The whole point of the strict check: a config round-tripped through a
  // form or a database can hold the STRING 'false', which is truthy.
  assert.equal(
    isTransparent({ [TRANSPARENT_KEY]: 'false' }),
    false,
    'the string "false" is truthy — a loose check would turn the option ON when it was switched OFF'
  );
  assert.equal(isTransparent({}), false, 'an absent key is not transparent');
  assert.equal(isTransparent(null), false, 'a null config must not throw');
});

/* ── 2. On by default for hero and apps, off elsewhere ─────────────────── */

for (const [name, definition] of [
  ['hero', heroWidget],
  ['apps', appsWidgetDefinition],
]) {
  test(`the ${name} widget declares the transparent option`, () => {
    const field = definition.configSchema.find((f) => f.key === TRANSPARENT_KEY);
    assert.ok(
      field,
      `the ${name} widget has no "${TRANSPARENT_KEY}" field. Without it the option ` +
        'is not in the settings form and the tile keeps its card chrome.'
    );
  });

  test(`the ${name} widget is transparent by DEFAULT, with no config at all`, () => {
    // The load-bearing assertion. A saved instance predating this option has
    // no `transparent` key, and `applyDefaults` is what the host runs before
    // the tile is classed — so if the default were false, every EXISTING hero
    // and apps widget would keep its box and the change would appear to do
    // nothing at all on a dashboard that already exists.
    const config = applyDefaults(definition.configSchema, {});
    assert.equal(
      isTransparent(config),
      true,
      `${name} must default to transparent; got ${JSON.stringify(config[TRANSPARENT_KEY])}`
    );
  });

  test(`the ${name} widget's stub config is transparent too`, () => {
    // "Add widget" must produce the same thing the default roster produces,
    // or a freshly added apps widget wears a box its neighbour does not.
    assert.equal(isTransparent(definition.getStubConfig()), true);
  });
}

test('the option defaults to OFF for a widget that does not ask for it', () => {
  // The other half of "on by default for hero and apps". If the default were
  // on everywhere this would be a global chrome removal wearing the costume
  // of a per-widget option, and the clock and torrents tiles would lose the
  // borders they actually need.
  assert.equal(transparentField().default, false, 'the field must default to false when unasked');
  assert.equal(isTransparent(applyDefaults([transparentField()], {})), false);
});

/* ── 3. The class goes on, and comes back OFF ──────────────────────────── */

test('applyTransparent adds the class for a transparent config', () => {
  const tile = fakeTile('grid-stack-item-content haven-widget-tile');
  assert.equal(applyTransparent(tile, { [TRANSPARENT_KEY]: true }), true);
  assert.ok(tile.classList.contains(TRANSPARENT_CLASS));
});

test('applyTransparent REMOVES the class when the option is switched off', () => {
  // The settings panel calls this again on every save. A one-way `add` would
  // let the option be turned on and never off — the user would switch the
  // background back to "card", watch the form close, and see nothing change
  // until a full reload.
  const tile = fakeTile(`haven-widget-tile ${TRANSPARENT_CLASS}`);
  assert.equal(applyTransparent(tile, { [TRANSPARENT_KEY]: false }), false);
  assert.ok(
    !tile.classList.contains(TRANSPARENT_CLASS),
    `expected the class to be removed, got "${tile.className}"`
  );
  // ...and the tile's own classes survive the removal.
  assert.ok(tile.classList.contains('haven-widget-tile'));
});

test('applyTransparent is idempotent', () => {
  const tile = fakeTile('haven-widget-tile');
  applyTransparent(tile, { [TRANSPARENT_KEY]: true });
  applyTransparent(tile, { [TRANSPARENT_KEY]: true });
  const hits = tile.className.split(/\s+/).filter((c) => c === TRANSPARENT_CLASS);
  assert.equal(hits.length, 1, `class applied ${hits.length} times: "${tile.className}"`);
});

test('applyTransparent tolerates a tile that is not there', () => {
  // It runs on a settings save, which can arrive for a widget whose tile has
  // been removed. Throwing there would escape into the panel's close path.
  assert.doesNotThrow(() => applyTransparent(null, { [TRANSPARENT_KEY]: true }));
  assert.doesNotThrow(() => applyTransparent({}, { [TRANSPARENT_KEY]: true }));
});

/* ── 4. The class actually removes the chrome ──────────────────────────── */

test('the transparent class strips the border, background and shadow', () => {
  const rule = ruleFor(`.${TRANSPARENT_CLASS}`);

  assert.ok(
    rule,
    `main.css has no \`.${TRANSPARENT_CLASS}\` rule. The class would land on every ` +
      'hero and apps tile and do absolutely nothing — the option would be fully ' +
      'wired, fully tested at the DOM level, and invisible.'
  );
  assert.match(rule, /border-color\s*:\s*transparent/, `expected the border gone, found: ${rule}`);
  assert.match(
    rule,
    /background\s*:\s*none/,
    'must clear the `background` SHORTHAND. `.haven-widget-tile` sets `background:` ' +
      'as a shorthand, so a longhand `background-color` would leave any image or ' +
      `gradient behind. Found: ${rule}`
  );
  assert.match(rule, /box-shadow\s*:\s*none/, `expected the shadow gone, found: ${rule}`);
});

test('the tile it strips really does have chrome to strip', () => {
  // Anti-vacuity, and the reason this is not a one-line test. The rule above
  // is only load-bearing because `.haven-widget-tile` paints a border, a
  // background and a shadow. If it ever stopped, the override would look like
  // dead CSS and be a candidate for deletion — and this test would go on
  // passing while the option quietly did nothing.
  const base = ruleFor('.haven-widget-tile');

  assert.ok(base, 'main.css has no `.haven-widget-tile` rule');
  assert.match(base, /border\s*:/, `nothing to remove — the tile has no border: ${base}`);
  assert.match(base, /background\s*:/, `nothing to remove — the tile has no background: ${base}`);
  assert.match(base, /box-shadow\s*:/, `nothing to remove — the tile has no shadow: ${base}`);
});

test('the transparent tile drops the card padding too', () => {
  // A full-bleed banner inset by 16px is not full-bleed. Without this the
  // hero keeps a visible margin of page background inside an invisible tile.
  const rule = ruleFor(`.${TRANSPARENT_CLASS} .haven-widget__body`);

  assert.ok(rule, `main.css does not clear the body padding for .${TRANSPARENT_CLASS}`);
  assert.match(rule, /padding\s*:\s*0/, `expected padding:0, found: ${rule}`);
});

/* ── 5. ...and puts it all back in EDIT mode ───────────────────────────── */

test('EDIT mode restores the tile bounds — the half that makes this safe', () => {
  // Without this the option would be a trap rather than a feature. It is ON
  // by default for the two LARGEST tiles on the dashboard, so in edit mode
  // the hero and the whole apps grid would be invisible drag targets at once:
  // no border to grab, no bounds to aim a drop at, nothing to resize by.
  const rule = ruleFor(`.haven-grid--edit-mode .${TRANSPARENT_CLASS}`);

  assert.ok(
    rule,
    'nothing restores the tile chrome in edit mode. The transparent option must ' +
      'apply in VIEW MODE ONLY — in edit mode the tile needs its visible bounds ' +
      'so it can be dragged.'
  );
  assert.match(rule, /border-color\s*:/, `expected the border back, found: ${rule}`);
  assert.match(rule, /background\s*:/, `expected the background back, found: ${rule}`);
  assert.match(rule, /box-shadow\s*:\s*var\(/, `expected the shadow back, found: ${rule}`);
});

test('EDIT mode restores the body padding as well as the border', () => {
  // Restoring the border but not the padding leaves the widget flush against
  // a dashed outline, which reads as a rendering bug rather than a mode.
  const rule = ruleFor(`.haven-grid--edit-mode .${TRANSPARENT_CLASS} .haven-widget__body`);

  assert.ok(rule, 'edit mode restores the tile border but not its body padding');
  assert.match(rule, /padding\s*:\s*var\(/, `expected the padding back, found: ${rule}`);
});

test('the edit-mode override can actually win the cascade', () => {
  // Specificity, asserted rather than assumed. `.haven-grid--edit-mode .X` is
  // two classes against the one-class rule it overrides, so it wins on
  // specificity — but only while the base rule stays a single class. If the
  // base ever gained a second the two would tie, source order would decide,
  // and edit mode would silently stop restoring the bounds.
  const baseAt = CSS_RULES.indexOf(`.${TRANSPARENT_CLASS} {`);
  const editAt = CSS_RULES.indexOf(`.haven-grid--edit-mode .${TRANSPARENT_CLASS} {`);

  assert.ok(baseAt >= 0 && editAt >= 0, 'expected both the base and edit-mode rules');
  assert.ok(
    editAt > baseAt,
    'the edit-mode override must come AFTER the base rule in source order, so it ' +
      'wins even if the two are ever made equally specific'
  );
});

/* ── 6. The wiring: the class is applied where tiles are built ─────────── */

const GRID_SRC = readFileSync(new URL('../src/shell/dashboard-grid.js', import.meta.url), 'utf8');
const BOOT_SRC = readFileSync(new URL('../src/shell/boot.js', import.meta.url), 'utf8');

test('dashboard-grid applies the option when it builds a tile', () => {
  assert.match(
    GRID_SRC,
    /applyTransparent\(/,
    'nothing applies the transparent class when a tile is placed — the schema field ' +
      'would exist, validate, persist, and never reach the DOM'
  );
});

test('the option is read from the HOST config, not the raw entry', () => {
  // `entry.config` is what was stored; `host.config` is what came out of
  // `migrateConfig` + `parseConfig` WITH schema defaults applied. Reading the
  // raw entry would mean an instance saved before this option existed has no
  // `transparent` key at all, so it would stay boxed — the default would only
  // ever apply to widgets added after this change.
  assert.match(
    GRID_SRC,
    /applyTransparent\(\s*content\s*,\s*host\.config\s*\)/,
    'the tile must be classed from `host.config` (defaults applied), not `entry.config`'
  );
});

test('a settings save re-applies the option', () => {
  // `host.setConfig` updates the widget INSIDE the tile and never touches the
  // tile itself, so without this the option saves correctly and appears to do
  // nothing until the next full page load.
  assert.match(
    GRID_SRC,
    /refreshChrome/,
    'dashboard-grid exposes no way to re-apply tile chrome after a config change'
  );
  assert.match(
    BOOT_SRC,
    /refreshChrome/,
    'boot.js never calls `refreshChrome`, so changing the option in the settings ' +
      'panel updates the config and leaves the tile exactly as it was'
  );
});
