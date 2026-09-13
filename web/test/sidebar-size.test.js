/**
 * Sidebar sizing: per-card heights and the column's width.
 *
 * ── What these tests are actually defending ──────────────────────────────
 * The sidebar's structure is load-bearing in a way that fails SILENTLY.
 * `.haven-sidebar__scroll` holds the unpinned cards; the pinned Server Status
 * card is its sibling, outside it. Measured at 1440x900, three cards appended
 * beside the pin drive the scrollport's `clientHeight` to 0px, and because
 * `.haven-sidebar` is `overflow: hidden` those cards are then unreachable with
 * no scrollbar — persisted, invisible, unrecoverable from the UI.
 *
 * A reviewer previously established that the scrollport needs no `min-height`
 * floor BECAUSE the pinned card is content-sized and the scrollport is
 * `flex: 1 1 auto; min-height: 0`. User-settable heights could break that
 * premise, so the two rules that keep it true are asserted here rather than
 * trusted to code review:
 *
 *   1. a height lands on the card BODY, never on the card or the sidebar
 *   2. the pinned card is not resizable at all
 *
 * Neither throws when broken. Both are a silent layout failure in a browser.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createSidebar } from '../src/shell/sidebar.js';
import {
  MAX_CARD_HEIGHT,
  MIN_CARD_HEIGHT,
  SIDEBAR_WIDTH,
  applyCardHeight,
  applySidebarWidth,
  clampCardHeight,
  clampSidebarWidth,
  createSidebarSizing,
} from '../src/shell/sidebar-size.js';
import { createFakeDocument } from './helpers/fake-dom.js';

const entry = (id, type = 'weather', over = {}) => ({
  id,
  type,
  config: {},
  zone: 'sidebar',
  ...over,
});

const SEEDED = [
  entry('sidebar-weather', 'weather'),
  entry('sidebar-calendar', 'calendar'),
  entry('sidebar-status', 'status'),
];

const cardSpecFor = (e) => ({
  id: e.id,
  type: e.type,
  title: e.id,
  pinned: e.type === 'status',
});

/**
 * A layout element double.
 *
 * Only `style.setProperty` matters: the width is applied by setting the CSS
 * custom property the layout's `grid-template-columns` already reads, so what
 * is asserted is the property, not a pixel measurement the fake DOM could not
 * produce anyway.
 */
function fakeLayout() {
  const props = new Map();
  return {
    props,
    style: {
      setProperty: (name, value) => props.set(name, value),
    },
    classList: { add() {}, remove() {}, toggle() {} },
  };
}

function fakeClient() {
  const saves = [];
  return {
    saves,
    save(id, body) {
      saves.push({ id, ...body });
      return Promise.resolve({});
    },
  };
}

function fakePreferences() {
  const saves = [];
  return {
    saves,
    save(patch) {
      saves.push(patch);
      return Promise.resolve({});
    },
  };
}

function setup({ instances = SEEDED, controls = true } = {}) {
  const doc = createFakeDocument();
  const sidebar = createSidebar({
    cards: instances.map(cardSpecFor),
    controls,
    document: doc,
  });
  const layoutEl = fakeLayout();
  const instancesClient = fakeClient();
  const preferencesClient = fakePreferences();

  const sizing = createSidebarSizing({
    sidebar,
    layoutEl,
    preferencesClient,
    instancesClient,
    entries: () => instances,
  });

  return { doc, sidebar, layoutEl, sizing, instancesClient, preferencesClient, instances };
}

/* ── the pure clamps ─────────────────────────────────────────────────────── */

test('a card height is clamped to a floor and a ceiling', () => {
  assert.equal(clampCardHeight(10), MIN_CARD_HEIGHT);
  assert.equal(clampCardHeight(999_999), MAX_CARD_HEIGHT);
  assert.equal(clampCardHeight(300), 300);
  // Fractional pixels come out of a real drag; a stored height is an integer.
  assert.equal(clampCardHeight(300.6), 301);
});

test('the sidebar width is clamped to its range', () => {
  assert.equal(clampSidebarWidth(0), SIDEBAR_WIDTH.min);
  assert.equal(clampSidebarWidth(99_999), SIDEBAR_WIDTH.max);
  assert.equal(clampSidebarWidth(420), 420);
});

/* ── 1. a height bounds the BODY, which is what protects the scrollport ─── */

test('a card height lands on the BODY, never on the card element', () => {
  // THE invariant. A height on the CARD lets it grow without bound and
  // compete with the pinned card for the column's height — the measured
  // starvation case. A height on the BODY with `overflow-y: auto` bounds the
  // card's contribution instead, so a user-set height can only ever make a
  // card SHORTER than its content.
  const { sidebar } = setup();
  const card = sidebar.cards.get('sidebar-calendar');

  applyCardHeight(card, 240);

  assert.equal(card.body.style.height, '240px', 'the body must carry the height');
  assert.equal(
    card.el.style.height,
    undefined,
    'the CARD must not carry a height — that is what starves the scrollport'
  );
});

test('a sized card scrolls internally rather than clipping', () => {
  // Without `overflow-y: auto` a fixed height is a CROP: the content below the
  // cut is unreachable by any means. Ope asked for an internal scrollbar
  // specifically, so this is the feature, not a detail.
  const { sidebar } = setup();
  const card = sidebar.cards.get('sidebar-calendar');

  applyCardHeight(card, 200);

  assert.equal(card.body.style.overflowY, 'auto');
});

test('a null height clears back to content sizing', () => {
  // `null` is a real value here — it is how a user undoes a resize. Treating
  // a falsy height as "no change" would make clearing impossible to express.
  const { sidebar } = setup();
  const card = sidebar.cards.get('sidebar-calendar');

  applyCardHeight(card, 240);
  applyCardHeight(card, null);

  assert.equal(card.body.style.height, '', 'the inline height must be removed');
  assert.equal(card.body.style.overflowY, '', 'the inline overflow must be removed');
});

/* ── 2. the pinned card is not resizable ─────────────────────────────────── */

test('the pinned card is REFUSED a height', () => {
  // The pinned card is the sidebar's own child rather than a child of the
  // scrollport, so a fixed height on it takes space FROM the scrollport
  // instead of being absorbed by it. That is the premise the "no min-height
  // floor is needed" argument rests on, and this is what keeps it true.
  const { sidebar } = setup();
  const pinned = sidebar.cards.get('sidebar-status');

  assert.equal(pinned.pinned, true, 'precondition: the status card is pinned');
  assert.equal(applyCardHeight(pinned, 300), false, 'a pinned card must refuse a height');
  assert.equal(pinned.body.style.height, undefined, 'no height may be written to a pinned card');
});

test('setHeight refuses the pinned card too, not just the low-level helper', () => {
  // Asserted through the controller as well, because that is the path the UI
  // uses. A guard in only one of the two is a guard a caller can walk around.
  const { sizing, sidebar } = setup();

  assert.equal(sizing.setHeight('sidebar-status', 300), false);
  assert.equal(sidebar.cards.get('sidebar-status').body.style.height, undefined);
});

test('the pinned card is built with no resize grip to offer', () => {
  // Belt and braces: the refusal above is the rule, and this is why a user
  // never encounters it — there is no affordance on the pinned card at all.
  const { sidebar } = setup();

  assert.equal(sidebar.cards.get('sidebar-status').grip, null);
  assert.ok(sidebar.cards.get('sidebar-calendar').grip, 'unpinned cards DO get a grip');
});

/* ── 3. the width ────────────────────────────────────────────────────────── */

test('the width is applied as the CSS custom property the layout reads', () => {
  // `grid-template-columns: 1fr var(--haven-sidebar-width)` is what sizes the
  // track, so setting the property IS resizing the sidebar. Asserting the
  // property rather than a measurement is the honest test in a fake DOM.
  const { sizing, layoutEl } = setup();

  sizing.setWidth(420);

  assert.equal(layoutEl.props.get('--haven-sidebar-width'), '420px');
});

test('a width beyond the range is clamped, not refused', () => {
  // A drag naturally overshoots. Refusing it would make the handle feel
  // broken at the extremes; clamping stops where the server would clamp too.
  const { sizing, layoutEl } = setup();

  assert.equal(sizing.setWidth(99_999), SIDEBAR_WIDTH.max);
  assert.equal(layoutEl.props.get('--haven-sidebar-width'), `${SIDEBAR_WIDTH.max}px`);
});

test('applySidebarWidth tolerates a missing layout element', () => {
  // The sidebar is not mounted in every boot path (`layoutEl` can be null), and
  // a resize helper that threw there would take the whole boot down.
  assert.equal(applySidebarWidth(null, 400), 400);
});

/* ── 4. drafting: nothing persists until commit ──────────────────────────── */

test('resizing does NOT write to the server before Save', () => {
  // Ope: "changes should be drafted if i don't click save and i refresh my
  // changes should be lost not persisted". A resize that persisted on
  // mouse-up would contradict that and leave Discard nothing to restore.
  const { sizing, instancesClient, preferencesClient } = setup();

  sizing.snapshot();
  sizing.setWidth(500);
  sizing.setHeight('sidebar-calendar', 200);

  assert.deepEqual(instancesClient.saves, [], 'no instance may be written while dragging');
  assert.deepEqual(preferencesClient.saves, [], 'no preference may be written while dragging');
});

test('commit writes the width and only the heights that changed', async () => {
  // Each height costs a PUT of a whole instance, so resizing one card in a
  // three-card sidebar must write one row rather than three — the same rule
  // `renumber` follows for reordering.
  const { sizing, instancesClient, preferencesClient } = setup();

  sizing.snapshot();
  sizing.setWidth(500);
  sizing.setHeight('sidebar-calendar', 200);
  await sizing.commit();

  assert.deepEqual(preferencesClient.saves, [{ sidebarWidth: 500 }]);
  assert.equal(instancesClient.saves.length, 1, 'only the resized card may be written');
  assert.equal(instancesClient.saves[0].id, 'sidebar-calendar');
  assert.equal(instancesClient.saves[0].height, 200);
  // The zone must ride along: the server reads a full replace, and omitting it
  // would relocate the card to the grid.
  assert.equal(instancesClient.saves[0].zone, 'sidebar');
});

test('commit skips a card whose height did NOT change this session', async () => {
  // Anti-vacuity for the test above, and it caught a real gap: with only one
  // card ever resized, "write the changed ones" and "write all of them" are
  // the same single write, so that test passes either way. A mutation
  // replacing the skip with `if (false) continue` survived it.
  //
  // Here TWO cards carry heights and only one is touched, so the two
  // behaviours diverge: correct code writes one row, the mutant writes two.
  const instances = [
    entry('sidebar-weather', 'weather', { height: 200 }),
    entry('sidebar-calendar', 'calendar', { height: 300 }),
    entry('sidebar-status', 'status'),
  ];
  const { sizing, instancesClient } = setup({ instances });

  sizing.load({ entries: instances });
  sizing.snapshot();
  sizing.setHeight('sidebar-calendar', 250);
  await sizing.commit();

  assert.deepEqual(
    instancesClient.saves.map((s) => s.id),
    ['sidebar-calendar'],
    'only the card that actually changed may be written — each height costs a PUT'
  );
});

test('commit writes nothing when nothing was resized', async () => {
  const { sizing, instancesClient, preferencesClient } = setup();

  sizing.snapshot();
  await sizing.commit();

  assert.deepEqual(instancesClient.saves, []);
  assert.deepEqual(preferencesClient.saves, []);
});

test('discard restores the sizes AND the DOM, not just the numbers', () => {
  // A discard that only reset the model would leave the column visibly the
  // wrong size until the next reload — the change would look saved.
  const { sizing, sidebar, layoutEl } = setup();

  sizing.load({ sidebarWidth: 320, entries: SEEDED });
  sizing.snapshot();

  sizing.setWidth(600);
  sizing.setHeight('sidebar-calendar', 150);
  sizing.discard();

  assert.equal(sizing.width, 320);
  assert.equal(layoutEl.props.get('--haven-sidebar-width'), '320px');
  assert.equal(
    sidebar.cards.get('sidebar-calendar').body.style.height,
    '',
    'a height added during the session must be cleared by Discard'
  );
});

test('discard restores a PREVIOUS height rather than clearing it', () => {
  // The other direction: a card that already had a height and was changed
  // must go back to the old height, not to content sizing.
  const { sizing, sidebar } = setup();

  sizing.load({ entries: [entry('sidebar-calendar', 'calendar', { height: 300 })] });
  sizing.snapshot();

  sizing.setHeight('sidebar-calendar', 150);
  sizing.discard();

  assert.equal(sidebar.cards.get('sidebar-calendar').body.style.height, '300px');
});

test('isDirty sees a height cleared back to content sizing', () => {
  // Comparing only "is there a height now" would miss a removal: the snapshot
  // holds a value and the current state holds none, which is a real change.
  const { sizing } = setup();

  sizing.load({ entries: [entry('sidebar-calendar', 'calendar', { height: 300 })] });
  sizing.snapshot();

  assert.equal(sizing.isDirty, false);
  sizing.setHeight('sidebar-calendar', null);
  assert.equal(sizing.isDirty, true);
});

test('isDirty is false before a snapshot exists', () => {
  // Outside edit mode there is nothing to compare against, and reporting
  // dirty there would light up Save on a dashboard nobody touched.
  const { sizing } = setup();
  sizing.setWidth(500);
  assert.equal(sizing.isDirty, false);
});

/* ── 5. load ─────────────────────────────────────────────────────────────── */

test('load applies a stored height and leaves an unset one content-sized', () => {
  // A card with no stored height must NOT be given a computed default — the
  // default is "as tall as your content" (DESIGN §3.1), which is the absence
  // of a height rather than a particular number.
  const { sizing, sidebar } = setup();

  sizing.load({
    entries: [
      entry('sidebar-calendar', 'calendar', { height: 260 }),
      entry('sidebar-weather', 'weather'),
    ],
  });

  assert.equal(sidebar.cards.get('sidebar-calendar').body.style.height, '260px');
  // Falsy rather than `undefined` specifically: `load` clears an unset height
  // through the same path that clears a set one, which writes `''`. Both mean
  // "no inline height" to a browser, and asserting the exact spelling would
  // pin an implementation detail of the fake DOM rather than the behaviour.
  assert.ok(
    !sidebar.cards.get('sidebar-weather').body.style.height,
    'a card with no stored height must carry no inline height'
  );
});

/* ── 6. the client and the server must agree on the range ────────────────── */

test('the width range matches the server validator', async () => {
  // The drag clamps client-side so the handle stops where the server would
  // refuse. If the two ranges drift, a user drags to a width that silently
  // snaps back on the next load — which looks like data loss, not a clamp.
  const server = await import('../../server/src/db/preferences-store.js');

  assert.equal(server.SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.min);
  assert.equal(server.SIDEBAR_WIDTH.max, SIDEBAR_WIDTH.max);
  assert.equal(server.SIDEBAR_WIDTH.default, SIDEBAR_WIDTH.default);
});

test('the card-height floor matches the server validator', async () => {
  const server = await import('../../server/src/db/instances-store.js');
  assert.equal(server.MIN_CARD_HEIGHT, MIN_CARD_HEIGHT);
});
