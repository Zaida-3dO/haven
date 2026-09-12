/**
 * The sidebar zone: add, reorder, remove.
 *
 * This is the half of the sidebar feature that `boot.js` structurally cannot
 * be tested for — it imports GridStack, whose ESM will not load under
 * `node --test` — which is exactly why the logic lives in its own module.
 *
 * Two of these tests are about things that fail SILENTLY in a browser and
 * would never throw: a card appended outside the scrollport (persisted,
 * invisible, unreachable) and a reorder that destroys and rebuilds its widget
 * hosts (every moved widget refetches; the 3D home reloads its whole scene).
 * Both are asserted directly rather than trusted to code review.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSidebar } from '../src/shell/sidebar.js';
import { createSidebarZone, renumber, reorder } from '../src/shell/sidebar-zone.js';
import { createFakeDocument } from './helpers/fake-dom.js';

const entry = (id, sortOrder, type = 'weather') => ({ id, type, config: {}, sortOrder });

/** The four seeded sidebar widgets, in their seeded order. */
const SEEDED = [
  entry('sidebar-weather', 0, 'weather'),
  entry('sidebar-calendar', 1, 'calendar'),
  entry('sidebar-home3d', 2, 'iframe'),
  entry('sidebar-status', 3, 'status'),
];

const cardSpecFor = (e) => ({
  id: e.id,
  type: e.type,
  title: e.id,
  pinned: e.type === 'status',
});

/**
 * A dashboard double that records teardowns.
 *
 * `destroyed` is the assertion surface for the re-parenting invariant: a
 * reorder that goes through `dashboard.remove()` would show up here, and a
 * reorder that re-parents leaves it empty.
 */
function fakeDashboard(doc) {
  const destroyed = [];
  const mounted = new Map();
  return {
    destroyed,
    mounted,
    add({ id, type }, container) {
      if (type === 'unknown') return null;
      const root = doc.createElement('div');
      root.id = id;
      container.appendChild(root);
      const host = { id, type, root };
      mounted.set(id, host);
      return host;
    },
    remove(id) {
      destroyed.push(id);
      mounted.delete(id);
    },
  };
}

/** Records every save/remove so persistence can be asserted without a server. */
function fakeClient() {
  const saves = [];
  const removes = [];
  return {
    saves,
    removes,
    save(id, body) {
      saves.push({ id, ...body });
      return Promise.resolve({});
    },
    remove(id) {
      removes.push(id);
      return Promise.resolve(true);
    },
  };
}

function setup({ instances = SEEDED, client = fakeClient() } = {}) {
  const doc = createFakeDocument();
  const sidebar = createSidebar({ cards: instances.map(cardSpecFor), document: doc });
  const dashboard = fakeDashboard(doc);

  for (const e of instances) {
    dashboard.add({ id: e.id, type: e.type }, sidebar.bodies.get(e.id));
  }

  const zone = createSidebarZone({
    sidebar,
    dashboard,
    instancesClient: client,
    cardSpecFor,
  });
  zone.load(instances);

  return { doc, sidebar, dashboard, zone, client };
}

/** Ids of the cards currently in the scrollport, in DOM order. */
const scrollOrder = (sidebar) =>
  sidebar.scroll.children.map(
    (el) => [...sidebar.cards.entries()].find(([, card]) => card.el === el)?.[0]
  );

/* ── the pure rules ──────────────────────────────────────────────────────── */

test('reorder moves an entry by one place', () => {
  const list = [entry('a', 0), entry('b', 1), entry('c', 2)];

  assert.deepEqual(
    reorder(list, 'c', -1).map((e) => e.id),
    ['a', 'c', 'b']
  );
  assert.deepEqual(
    reorder(list, 'a', 1).map((e) => e.id),
    ['b', 'a', 'c']
  );
});

test('a move off either end is a no-op, never a wrap-around', () => {
  // Wrapping reads as a bug to someone holding an arrow down: the top card
  // appearing at the bottom is indistinguishable from a misclick.
  const list = [entry('a', 0), entry('b', 1)];

  assert.deepEqual(
    reorder(list, 'a', -1).map((e) => e.id),
    ['a', 'b']
  );
  assert.deepEqual(
    reorder(list, 'b', 1).map((e) => e.id),
    ['a', 'b']
  );
});

test('reorder does not mutate its input', () => {
  const list = [entry('a', 0), entry('b', 1)];
  reorder(list, 'a', 1);
  assert.deepEqual(
    list.map((e) => e.id),
    ['a', 'b']
  );
});

test('an unknown id leaves the order alone rather than throwing', () => {
  const list = [entry('a', 0), entry('b', 1)];
  assert.deepEqual(
    reorder(list, 'ghost', 1).map((e) => e.id),
    ['a', 'b']
  );
});

test('renumber returns ONLY the entries whose number changed', () => {
  // Each changed entry costs a PUT. Moving the last card up in a four-card
  // sidebar must write two rows, not four.
  const list = [entry('a', 0), entry('c', 3), entry('b', 1)];
  const { entries, changed } = renumber(list);

  assert.deepEqual(
    entries.map((e) => e.sortOrder),
    [0, 1, 2]
  );
  assert.deepEqual(
    changed.map((e) => e.id),
    ['c', 'b']
  );
});

/* ── the controller ──────────────────────────────────────────────────────── */

test('load sorts by sortOrder, so the display order is the persisted order', () => {
  const { zone } = setup({
    instances: [entry('b', 5), entry('a', 1), entry('c', 9)],
  });

  assert.deepEqual(
    zone.entries.map((e) => e.id),
    ['a', 'b', 'c']
  );
});

test('a reorder RE-PARENTS the cards and destroys no widget host', () => {
  // THE invariant. `dashboard.remove()` calls `host.destroy()`, so a reorder
  // implemented as remove-then-add would refetch every moved widget and reload
  // the 3D home's entire WebGL scene. Nothing may be destroyed by a move.
  const { zone, sidebar, dashboard } = setup();
  const before = sidebar.cards.get('sidebar-calendar').el;

  zone.move('sidebar-calendar', -1);

  assert.deepEqual(dashboard.destroyed, [], 'a move must not destroy any host');
  assert.equal(
    sidebar.cards.get('sidebar-calendar').el,
    before,
    'the card element must be moved, not rebuilt'
  );
  assert.deepEqual(scrollOrder(sidebar), ['sidebar-calendar', 'sidebar-weather', 'sidebar-home3d']);
});

test('the pinned card stays OUTSIDE the scrollport across a reorder', () => {
  // It is the sidebar's own child so it holds the bottom edge. Pulling it into
  // the scrollport would let it scroll out of view — the bug the structure
  // exists to prevent.
  const { zone, sidebar } = setup();

  zone.move('sidebar-weather', 1);

  const pinned = sidebar.cards.get('sidebar-status');
  assert.equal(pinned.el.parentNode, sidebar.el, 'the pinned card must stay a sidebar child');
  assert.ok(
    !sidebar.scroll.children.includes(pinned.el),
    'the pinned card must never be inside the scrollport'
  );
});

test('a reorder persists only the rows that moved', () => {
  const { zone, client } = setup();

  zone.move('sidebar-calendar', -1);

  assert.deepEqual(
    client.saves.map((s) => s.id).sort(),
    ['sidebar-calendar', 'sidebar-weather'],
    'only the two swapped rows should be written'
  );
  for (const save of client.saves) assert.equal(save.zone, 'sidebar');
});

test('a no-op move writes nothing at all', () => {
  const { zone, client } = setup();

  zone.move('sidebar-weather', -1);

  assert.deepEqual(client.saves, [], 'a move that changes nothing must not write');
});

test('an added card lands INSIDE the scrollport, never beside the pin', () => {
  // Measured at 1440x900: three cards appended as siblings of the pin drive
  // the scrollport to 0px, and `overflow: hidden` then makes them unreachable
  // with no scrollbar. A widget that is persisted, invisible and unrecoverable
  // is strictly worse than one that failed to be added.
  const { zone, sidebar } = setup();

  zone.add(entry('sidebar-extra', 9, 'weather'));

  const card = sidebar.cards.get('sidebar-extra');
  assert.ok(card, 'the card should have been built');
  assert.equal(card.el.parentNode, sidebar.scroll, 'a new card must go in the scrollport');
});

test('an added widget goes to the END of the sidebar', () => {
  const { zone } = setup();

  zone.add(entry('sidebar-extra', undefined, 'weather'));

  const ids = zone.entries.map((e) => e.id);
  assert.equal(ids.at(-1), 'sidebar-extra');
  assert.equal(zone.entries.at(-1).sortOrder, 4);
  assert.equal(zone.entries.at(-1).zone, 'sidebar');
});

test('an unknown widget type rolls its card back rather than leaving an empty box', () => {
  const { zone, sidebar } = setup();

  const host = zone.add({ id: 'sidebar-ghost', type: 'unknown', config: {} });

  assert.equal(host, null);
  assert.equal(sidebar.cards.has('sidebar-ghost'), false, 'the card should not survive');
  assert.equal(sidebar.bodies.has('sidebar-ghost'), false);
});

test('remove takes the host, the card and the roster row together', () => {
  const { zone, sidebar, dashboard, client } = setup();

  assert.equal(zone.remove('sidebar-calendar'), true);

  assert.deepEqual(dashboard.destroyed, ['sidebar-calendar'], 'the host must be destroyed');
  assert.equal(sidebar.cards.has('sidebar-calendar'), false);
  assert.deepEqual(client.removes, ['sidebar-calendar']);
  assert.deepEqual(
    zone.entries.map((e) => e.id),
    ['sidebar-weather', 'sidebar-home3d', 'sidebar-status']
  );
});

test('remove renumbers what is left, so the order keeps no hole', () => {
  // A hole is not cosmetic: the order is a dense 0..n-1 that a list index maps
  // onto directly, and a gap makes later index arithmetic wrong.
  const { zone, client } = setup();

  zone.remove('sidebar-weather');

  assert.deepEqual(
    zone.entries.map((e) => e.sortOrder),
    [0, 1, 2]
  );
  assert.ok(client.saves.length > 0, 'the survivors should be renumbered on the server too');
});

test('removing an unknown id is false, not a throw', () => {
  const { zone } = setup();
  assert.equal(zone.remove('ghost'), false);
});

test('a null instances client is not an error — the injected-roster case', () => {
  // `bootDashboard({instances})` builds no client at all. The controller must
  // still reorder and remove in the DOM rather than throwing on every click.
  const { zone, sidebar } = setup({ client: null });

  zone.move('sidebar-calendar', -1);
  assert.deepEqual(scrollOrder(sidebar), ['sidebar-calendar', 'sidebar-weather', 'sidebar-home3d']);

  assert.equal(zone.remove('sidebar-calendar'), true);
});

test('createSidebarZone refuses to be built without its dependencies', () => {
  assert.throws(() => createSidebarZone({}), /sidebar is required/);
  assert.throws(() => createSidebarZone({ sidebar: {} }), /dashboard is required/);
  assert.throws(() => createSidebarZone({ sidebar: {}, dashboard: {} }), /cardSpecFor is required/);
});

/* ── edit-mode controls ──────────────────────────────────────────────────── */

const withControls = (doc, instances = SEEDED, handlers = {}) =>
  createSidebar({
    cards: instances.map(cardSpecFor),
    controls: true,
    onMoveUp: handlers.onMoveUp ?? (() => {}),
    onMoveDown: handlers.onMoveDown ?? (() => {}),
    onRemove: handlers.onRemove ?? (() => {}),
    document: doc,
  });

const controlsOf = (card) => card.controls?.children ?? [];
const kindsOf = (card) => controlsOf(card).map((b) => b.dataset.sidebarControl);

test('a card renders no controls unless they are asked for', () => {
  // View-only mounts (and every existing caller) must not grow buttons.
  const doc = createFakeDocument();
  const sidebar = createSidebar({ cards: SEEDED.map(cardSpecFor), document: doc });

  assert.equal(sidebar.cards.get('sidebar-weather').controls, null);
});

test('controls are built DISABLED and untabbable, not merely hidden', () => {
  // Hiding with CSS alone would leave a keyboard user able to tab into a
  // control that does nothing in view mode.
  const doc = createFakeDocument();
  const sidebar = withControls(doc);

  for (const button of controlsOf(sidebar.cards.get('sidebar-weather'))) {
    assert.equal(button.disabled, true);
    assert.equal(button.tabIndex, -1);
  }
});

test('setEditable(true) actually ENABLES the controls', () => {
  // THE test for the finding behind this slice. `edit-mode.js` sweeps
  // `gridHandle.root`, and the sidebar is a SIBLING of the grid chrome — so a
  // sidebar control relying on that sweep would be built disabled and stay
  // disabled forever, with nothing throwing and no test noticing.
  const doc = createFakeDocument();
  const sidebar = withControls(doc);

  sidebar.setEditable(true);

  for (const button of controlsOf(sidebar.cards.get('sidebar-weather'))) {
    assert.equal(button.disabled, false, 'edit mode must enable sidebar controls');
    assert.equal(button.tabIndex, 0, 'an enabled control must be tabbable');
  }

  sidebar.setEditable(false);
  for (const button of controlsOf(sidebar.cards.get('sidebar-weather'))) {
    assert.equal(button.disabled, true, 'leaving edit mode must disable them again');
    assert.equal(button.tabIndex, -1);
  }
});

test('the pinned card gets Remove but no move arrows', () => {
  // It is the sidebar's own child rather than a child of the scrollport, so it
  // holds the bottom edge and is not part of the order — but a user must still
  // be able to get rid of it.
  const doc = createFakeDocument();
  const sidebar = withControls(doc);

  assert.deepEqual(kindsOf(sidebar.cards.get('sidebar-status')), ['remove']);
  assert.deepEqual(kindsOf(sidebar.cards.get('sidebar-weather')), ['up', 'down', 'remove']);
});

test('clicking a control calls through with the card id', () => {
  const calls = [];
  const doc = createFakeDocument();
  const sidebar = withControls(doc, SEEDED, {
    onMoveUp: (id) => calls.push(['up', id]),
    onMoveDown: (id) => calls.push(['down', id]),
    onRemove: (id) => calls.push(['remove', id]),
  });

  for (const button of controlsOf(sidebar.cards.get('sidebar-calendar'))) {
    button.listeners.get('click')?.forEach((fn) => fn());
  }

  assert.deepEqual(calls, [
    ['up', 'sidebar-calendar'],
    ['down', 'sidebar-calendar'],
    ['remove', 'sidebar-calendar'],
  ]);
});

test('a card added later gets controls too', () => {
  // `addCard` is the shared attach path; a card added at runtime must not come
  // out inert while the seeded ones are editable.
  const doc = createFakeDocument();
  const sidebar = withControls(doc);

  const card = sidebar.addCard({ id: 'sidebar-extra', type: 'weather', title: 'Extra' });

  assert.deepEqual(kindsOf(card), ['up', 'down', 'remove']);
});
