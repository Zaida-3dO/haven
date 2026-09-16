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
  const suspended = [];
  const resumed = [];
  const mounted = new Map();
  return {
    destroyed,
    suspended,
    resumed,
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
    // Mirrors the real Dashboard: stops polling/search WITHOUT destroying the
    // host, so the fake can assert the same "suspend, don't destroy" contract
    // `sidebar-zone.js`'s drafted `remove` depends on.
    suspend(id) {
      suspended.push(id);
    },
    resume(id) {
      resumed.push(id);
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

test('renumber never mutates its input entries, live or snapshotted', () => {
  // Load-bearing, not incidental: `cancelDraft` restores by pointing `entries`
  // straight at the `draftEntries` snapshot taken in `beginDraft`. If
  // `renumber` mutated an entry object in place rather than returning a copy,
  // that same object is the one sitting in the snapshot too, and Discard
  // would restore something already changed instead of the original.
  const list = [entry('a', 0), entry('c', 3), entry('b', 1)];
  // A second reference to the same objects, standing in for `draftEntries` —
  // a snapshot that shares objects with the live list is exactly the
  // situation `cancelDraft` relies on being safe.
  const snapshot = [...list];

  const before = list.map((e) => ({ ...e }));
  renumber(list);

  assert.deepEqual(list, before, 'the input array entries must be untouched');
  assert.deepEqual(snapshot, before, 'a snapshot sharing the same objects must also see no change');
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

/* ── drafting: nothing is written until the draft is committed ───────────── */

test('a reorder inside a draft writes NOTHING to the server', () => {
  // THE defect. Reorder used to persist `sortOrder` on the click, so
  // refreshing without saving KEPT the change. Ope: "changes should be
  // drafted if i don't click save and i refresh my changes should be lost".
  const { zone, client } = setup();

  zone.beginDraft();
  zone.move('sidebar-calendar', -1);

  assert.deepEqual(client.saves, [], 'a drafted reorder must not reach the server');
});

test('a drafted reorder still moves the cards on screen', () => {
  // Buffering the WRITE must not buffer the feedback: the user has to see the
  // card move immediately, or the arrows look broken.
  const { zone, sidebar } = setup();

  zone.beginDraft();
  zone.move('sidebar-calendar', -1);

  assert.deepEqual(scrollOrder(sidebar), ['sidebar-calendar', 'sidebar-weather', 'sidebar-home3d']);
});

test('committing a draft writes only the rows whose order actually changed', () => {
  const { zone, client } = setup();

  zone.beginDraft();
  zone.move('sidebar-calendar', -1);
  zone.commitDraft();

  assert.deepEqual(
    client.saves.map((s) => s.id).sort(),
    ['sidebar-calendar', 'sidebar-weather'],
    'only the two swapped rows should be written, and only on commit'
  );
});

/* ── updateConfig: keeping the zone's own copy in step with a settings save ── */

test('updateConfig replaces the stored config for that entry only', () => {
  const { zone } = setup();

  const ok = zone.updateConfig('sidebar-calendar', { title: 'Renamed', maxEvents: 42 });

  assert.equal(ok, true);
  const updated = zone.entries.find((e) => e.id === 'sidebar-calendar');
  assert.deepEqual(updated.config, { title: 'Renamed', maxEvents: 42 });

  // Nobody else's config moved.
  const weather = zone.entries.find((e) => e.id === 'sidebar-weather');
  assert.deepEqual(weather.config, {});
});

test('updateConfig on an unknown id is false, not a throw', () => {
  const { zone } = setup();
  assert.equal(zone.updateConfig('not-a-real-id', { anything: true }), false);
});

test('updateConfig does not reorder or otherwise disturb the entries', () => {
  const { zone } = setup();
  const before = zone.entries.map((e) => e.id);

  zone.updateConfig('sidebar-calendar', { maxEvents: 99 });

  assert.deepEqual(
    zone.entries.map((e) => e.id),
    before
  );
});

test('a settings save mid-draft is not clobbered when the reorder is later committed', () => {
  // THE defect this closes, found by hand: `commitDraft()`'s own renumber
  // pass persists every entry whose sortOrder changed using ITS copy of the
  // entry — which is exactly what goes stale if a settings save updates
  // `boot.js`'s `roster` but never touches `sidebarZone`'s own `entries`.
  // Reproduced live: changing a sidebar calendar's `maxEvents` to 42 during
  // an open drag draft appeared to save, and then clicking toolbar Save for
  // the reorder silently reverted the database to the pre-draft config.
  const { zone, client } = setup();

  zone.beginDraft();
  zone.move('sidebar-calendar', -1);
  // The settings panel's save path is `boot.js`'s persist(), which (after
  // this fix) calls updateConfig on the SAME zone instance mid-draft.
  zone.updateConfig('sidebar-calendar', { title: 'Calendar', maxEvents: 42 });
  zone.commitDraft();

  const written = client.saves.find((s) => s.id === 'sidebar-calendar');
  assert.ok(written, 'the reordered calendar row must still be written on commit');
  assert.deepEqual(
    written.config,
    { title: 'Calendar', maxEvents: 42 },
    "commitDraft's own persistence must use the UPDATED config, not the one " +
      'the draft opened with'
  );
});

test('cancelling a draft puts the original order back', () => {
  const { zone, sidebar, client } = setup();

  zone.beginDraft();
  zone.move('sidebar-calendar', -1);
  zone.cancelDraft();

  assert.deepEqual(
    zone.entries.map((e) => e.id),
    ['sidebar-weather', 'sidebar-calendar', 'sidebar-home3d', 'sidebar-status']
  );
  assert.deepEqual(scrollOrder(sidebar), ['sidebar-weather', 'sidebar-calendar', 'sidebar-home3d']);
  assert.deepEqual(client.saves, [], 'a cancelled draft must never have written');
});

test('a removal inside a draft destroys NOTHING and deletes NOTHING', () => {
  // The half that was impossible before: the row was deleted on the click, so
  // Discard had nothing to put back. Nothing may be torn down until Save.
  const { zone, dashboard, client, sidebar } = setup();

  zone.beginDraft();
  assert.equal(zone.remove('sidebar-calendar'), true);

  assert.deepEqual(dashboard.destroyed, [], 'the host must survive until the draft is committed');
  assert.deepEqual(client.removes, [], 'nothing may be deleted server-side during a draft');
  assert.ok(sidebar.cards.has('sidebar-calendar'), 'the card must be kept, so Discard can show it');
  assert.equal(sidebar.cards.get('sidebar-calendar').el.hidden, true, 'but hidden from view');
});

test('a removal inside a draft suspends the host: no more polling, no more search', () => {
  // The bug this item exists to close: hiding a card is not enough on its
  // own — `dashboard.remove` is the only caller of `scheduler.remove` and
  // `searchIndex.remove`, so a merely-hidden card kept hitting its endpoint
  // and kept turning up in Ctrl+K until Save or Discard. The fix suspends the
  // host (stop polling, drop from search) while stopping short of destroying
  // it, so Discard can still bring it back.
  const { zone, dashboard } = setup();

  zone.beginDraft();
  assert.equal(zone.remove('sidebar-calendar'), true);

  assert.deepEqual(
    dashboard.suspended,
    ['sidebar-calendar'],
    'the host must be suspended on removal'
  );
  assert.deepEqual(dashboard.destroyed, [], 'suspending is not destroying — the host must survive');
});

test('cancelling a draft brings a removed card BACK', () => {
  // Ope's second requirement, and the one the old design could not meet.
  const { zone, sidebar, dashboard, client } = setup();

  zone.beginDraft();
  zone.remove('sidebar-calendar');
  zone.cancelDraft();

  assert.equal(sidebar.cards.get('sidebar-calendar').el.hidden, false, 'the card must be visible');
  assert.deepEqual(
    zone.entries.map((e) => e.id),
    ['sidebar-weather', 'sidebar-calendar', 'sidebar-home3d', 'sidebar-status'],
    'the restored card must be back in its original place'
  );
  assert.deepEqual(dashboard.destroyed, [], 'and its widget must never have been torn down');
  assert.deepEqual(client.removes, []);
});

test('cancelling a draft resumes the suspended host: polling and search come back', () => {
  const { zone, dashboard } = setup();

  zone.beginDraft();
  zone.remove('sidebar-calendar');
  zone.cancelDraft();

  assert.deepEqual(
    dashboard.resumed,
    ['sidebar-calendar'],
    'Discard must undo the suspend, not just the hidden flag'
  );
});

test('committing a draft is what actually tears the removal down', () => {
  const { zone, sidebar, dashboard, client } = setup();

  zone.beginDraft();
  zone.remove('sidebar-calendar');
  zone.commitDraft();

  assert.deepEqual(dashboard.destroyed, ['sidebar-calendar'], 'the host is destroyed on commit');
  assert.deepEqual(client.removes, ['sidebar-calendar'], 'and the row deleted on commit');
  assert.equal(sidebar.cards.has('sidebar-calendar'), false);
});

test('a draft holding a removal is dirty even when the ids left are in the same order', () => {
  // The subtle one. Removing the LAST unpinned card leaves the survivors with
  // the same ids in the same order and already dense, so an order-only
  // comparison reports the draft clean and Save stays greyed out over a
  // removal the user can see has happened.
  const { zone } = setup();

  zone.beginDraft();
  assert.equal(zone.isDirty, false, 'a fresh draft is clean');

  zone.remove('sidebar-home3d');

  assert.equal(zone.isDirty, true, 'a pending removal must count as dirty');
});

test('isDirty tracks the draft and resets when it closes', () => {
  const { zone } = setup();

  assert.equal(zone.isDirty, false, 'no draft, nothing to save');

  zone.beginDraft();
  zone.move('sidebar-calendar', -1);
  assert.equal(zone.isDirty, true);

  zone.cancelDraft();
  assert.equal(zone.isDirty, false, 'a cancelled draft leaves nothing to save');

  zone.beginDraft();
  zone.move('sidebar-calendar', -1);
  zone.commitDraft();
  assert.equal(zone.isDirty, false, 'a committed draft leaves nothing to save');
});

test('a no-op move inside a draft leaves it clean', () => {
  // Pressing "up" on the top card must not arm Save over nothing.
  const { zone } = setup();

  zone.beginDraft();
  zone.move('sidebar-weather', -1);

  assert.equal(zone.isDirty, false);
});

test('beginDraft twice does not re-snapshot over the original order', () => {
  // The same rule as the grid's snapshot: re-snapshotting mid-session would
  // silently move the point Discard returns to.
  const { zone, sidebar } = setup();

  zone.beginDraft();
  zone.move('sidebar-calendar', -1);
  zone.beginDraft();
  zone.cancelDraft();

  assert.deepEqual(scrollOrder(sidebar), ['sidebar-weather', 'sidebar-calendar', 'sidebar-home3d']);
});

test('outside a draft, move and remove still persist immediately', () => {
  // The programmatic/injected-roster callers never open a draft, and must keep
  // working exactly as before.
  const { zone, client, dashboard } = setup();

  zone.move('sidebar-calendar', -1);
  assert.ok(client.saves.length > 0, 'an undrafted move still writes');

  zone.remove('sidebar-calendar');
  assert.deepEqual(client.removes, ['sidebar-calendar'], 'an undrafted remove still deletes');
  assert.deepEqual(dashboard.destroyed, ['sidebar-calendar']);
});

test('a draft with a null client restores without throwing', () => {
  // `bootDashboard({instances})` has no server. Drafting must still work in
  // the DOM rather than throwing on commit or cancel.
  const { zone, sidebar } = setup({ client: null });

  zone.beginDraft();
  zone.remove('sidebar-calendar');
  zone.cancelDraft();

  assert.equal(sidebar.cards.get('sidebar-calendar').el.hidden, false);
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
    onSettings: handlers.onSettings ?? (() => {}),
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

test('the pinned card gets Settings and Remove but no move arrows', () => {
  // It is the sidebar's own child rather than a child of the scrollport, so it
  // holds the bottom edge and is not part of the order — but a user must still
  // be able to get rid of it, and its config stays reachable even though its
  // position does not move.
  const doc = createFakeDocument();
  const sidebar = withControls(doc);

  assert.deepEqual(kindsOf(sidebar.cards.get('sidebar-status')), ['settings', 'remove']);
  assert.deepEqual(kindsOf(sidebar.cards.get('sidebar-weather')), [
    'up',
    'down',
    'settings',
    'remove',
  ]);
});

test('clicking a control calls through with the card id', () => {
  const calls = [];
  const doc = createFakeDocument();
  const sidebar = withControls(doc, SEEDED, {
    onMoveUp: (id) => calls.push(['up', id]),
    onMoveDown: (id) => calls.push(['down', id]),
    onRemove: (id) => calls.push(['remove', id]),
    onSettings: (id) => calls.push(['settings', id]),
  });

  for (const button of controlsOf(sidebar.cards.get('sidebar-calendar'))) {
    button.listeners.get('click')?.forEach((fn) => fn());
  }

  assert.deepEqual(calls, [
    ['up', 'sidebar-calendar'],
    ['down', 'sidebar-calendar'],
    ['settings', 'sidebar-calendar'],
    ['remove', 'sidebar-calendar'],
  ]);
});

test('a card added later gets controls too', () => {
  // `addCard` is the shared attach path; a card added at runtime must not come
  // out inert while the seeded ones are editable.
  const doc = createFakeDocument();
  const sidebar = withControls(doc);

  const card = sidebar.addCard({ id: 'sidebar-extra', type: 'weather', title: 'Extra' });

  assert.deepEqual(kindsOf(card), ['up', 'down', 'settings', 'remove']);
});
