import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { MODE, createEditMode } from '../src/shell/edit-mode.js';

/**
 * A stand-in for the handle `mountGrid` returns.
 *
 * It models the two behaviours edit mode actually depends on: `extract`
 * returns the current geometry for a breakpoint, and `applyLayout` puts a
 * previous geometry back — which is what Discard is.
 */
function fakeGridHandle({ breakpoint = 'desktop', nodes = [] } = {}) {
  const state = {
    breakpoint,
    nodes: [...nodes],
    editable: null,
    applied: [],
    classes: new Set(),
  };

  return {
    state,
    root: {
      classList: {
        toggle: (name, on) => (on ? state.classes.add(name) : state.classes.delete(name)),
        contains: (name) => state.classes.has(name),
      },
      // No widget tiles in these tests; the dim/inert sweep is exercised
      // against the real DOM shape in the browser, not here.
      querySelectorAll: () => [],
    },
    breakpoint: () => state.breakpoint,
    extract: () => state.nodes.map((n) => ({ ...n })),
    applyLayout: (layout) => {
      state.applied.push(layout);
      state.nodes = layout.map((n) => ({ ...n }));
    },
    setEditable: (on) => {
      state.editable = on;
    },
  };
}

/** A layout client that records what it was asked to save. */
function fakeLayoutClient({ fail = false } = {}) {
  const saves = [];
  return {
    saves,
    async save(payload) {
      saves.push(payload);
      if (fail) throw new Error('network down');
      return { saved: Object.keys(payload) };
    },
  };
}

describe('entering and leaving edit mode', () => {
  test('starts in view mode, with the grid not editable', () => {
    const gridHandle = fakeGridHandle();
    const editMode = createEditMode({ gridHandle, layoutClient: fakeLayoutClient() });

    assert.equal(editMode.mode, MODE.VIEW);
    assert.equal(editMode.isEditing, false);
  });

  test('entering makes the grid editable; view mode makes it static again', () => {
    // The explicit toggle is the whole decision here: always-on dragging means
    // an accidental drag every time you try to click something in a widget.
    const gridHandle = fakeGridHandle();
    const editMode = createEditMode({ gridHandle, layoutClient: fakeLayoutClient() });

    editMode.enter();
    assert.equal(gridHandle.state.editable, true);

    editMode.discard();
    assert.equal(gridHandle.state.editable, false);
  });

  test('entering twice does not re-snapshot over the original layout', async () => {
    const gridHandle = fakeGridHandle({ nodes: [{ id: 'a', x: 0, y: 0, w: 2, h: 2 }] });
    const editMode = createEditMode({ gridHandle, layoutClient: fakeLayoutClient() });

    editMode.enter();
    // The user drags something, then something re-enters edit mode.
    gridHandle.state.nodes = [{ id: 'a', x: 5, y: 5, w: 2, h: 2 }];
    editMode.enter();

    editMode.discard();

    // Discard must still restore the layout as it was on FIRST entry.
    assert.deepEqual(gridHandle.state.nodes, [{ id: 'a', x: 0, y: 0, w: 2, h: 2 }]);
  });

  test('the toggle moves between the two modes', () => {
    const editMode = createEditMode({
      gridHandle: fakeGridHandle(),
      layoutClient: fakeLayoutClient(),
    });

    editMode.toggle();
    assert.equal(editMode.isEditing, true);
    editMode.toggle();
    assert.equal(editMode.isEditing, false);
  });
});

describe('discard', () => {
  test('restores the layout exactly as it was on entry', () => {
    const original = [
      { id: 'a', x: 0, y: 0, w: 2, h: 2 },
      { id: 'b', x: 2, y: 0, w: 2, h: 2 },
    ];
    const gridHandle = fakeGridHandle({ nodes: original });
    const editMode = createEditMode({ gridHandle, layoutClient: fakeLayoutClient() });

    editMode.enter();
    gridHandle.state.nodes = [{ id: 'a', x: 6, y: 4, w: 1, h: 1 }];
    editMode.discard();

    assert.deepEqual(gridHandle.state.nodes, original);
  });

  test('saves nothing — discard is not a quiet save', () => {
    const layoutClient = fakeLayoutClient();
    const editMode = createEditMode({ gridHandle: fakeGridHandle(), layoutClient });

    editMode.enter();
    editMode.discard();

    assert.equal(layoutClient.saves.length, 0);
  });

  test('does nothing when not editing', () => {
    const gridHandle = fakeGridHandle();
    const editMode = createEditMode({ gridHandle, layoutClient: fakeLayoutClient() });

    editMode.discard();

    assert.equal(gridHandle.state.applied.length, 0);
  });
});

describe('save', () => {
  test('sends only the breakpoint being edited', async () => {
    // The guarantee that matters: desktop and mobile are arranged separately
    // and neither is derived from the other. A PUT carrying both would let a
    // desktop edit overwrite a mobile layout nobody looked at.
    const gridHandle = fakeGridHandle({
      breakpoint: 'desktop',
      nodes: [{ id: 'a', x: 1, y: 2, w: 3, h: 4 }],
    });
    const layoutClient = fakeLayoutClient();
    const editMode = createEditMode({ gridHandle, layoutClient });

    editMode.enter();
    await editMode.save();

    assert.deepEqual(Object.keys(layoutClient.saves[0]), ['desktop']);
    assert.deepEqual(layoutClient.saves[0].desktop, [{ id: 'a', x: 1, y: 2, w: 3, h: 4 }]);
  });

  test('saves mobile — and only mobile — when editing the mobile breakpoint', async () => {
    const gridHandle = fakeGridHandle({
      breakpoint: 'mobile',
      nodes: [{ id: 'a', x: 0, y: 0, w: 4, h: 2 }],
    });
    const layoutClient = fakeLayoutClient();
    const editMode = createEditMode({ gridHandle, layoutClient });

    editMode.enter();
    await editMode.save();

    assert.deepEqual(Object.keys(layoutClient.saves[0]), ['mobile']);
  });

  test('returns to view mode on success', async () => {
    const editMode = createEditMode({
      gridHandle: fakeGridHandle(),
      layoutClient: fakeLayoutClient(),
    });

    editMode.enter();
    await editMode.save();

    assert.equal(editMode.mode, MODE.VIEW);
  });

  test('stays in edit mode when the save fails, so the arrangement is not lost', async () => {
    // Dropping to view mode on a failed save would look exactly like success
    // and would throw away work the user just did.
    const errors = [];
    const editMode = createEditMode({
      gridHandle: fakeGridHandle(),
      layoutClient: fakeLayoutClient({ fail: true }),
      onError: (err) => errors.push(err),
    });

    editMode.enter();
    await assert.rejects(() => editMode.save(), /network down/);

    assert.equal(editMode.isEditing, true);
    assert.equal(errors.length, 1);
  });

  test('a failed save leaves the snapshot intact, so discard still works', async () => {
    const original = [{ id: 'a', x: 0, y: 0, w: 2, h: 2 }];
    const gridHandle = fakeGridHandle({ nodes: original });
    const editMode = createEditMode({
      gridHandle,
      layoutClient: fakeLayoutClient({ fail: true }),
      onError: () => {},
    });

    editMode.enter();
    gridHandle.state.nodes = [{ id: 'a', x: 7, y: 7, w: 1, h: 1 }];
    await assert.rejects(() => editMode.save());

    editMode.discard();

    assert.deepEqual(gridHandle.state.nodes, original);
  });

  test('does nothing outside edit mode', async () => {
    const layoutClient = fakeLayoutClient();
    const editMode = createEditMode({ gridHandle: fakeGridHandle(), layoutClient });

    assert.equal(await editMode.save(), null);
    assert.equal(layoutClient.saves.length, 0);
  });
});

describe('pending removals', () => {
  test('are recorded during an edit session and cleared by discard', () => {
    const editMode = createEditMode({
      gridHandle: fakeGridHandle(),
      layoutClient: fakeLayoutClient(),
    });

    editMode.enter();
    editMode.noteRemoval('clock-1');

    assert.deepEqual(editMode.pendingRemovals, ['clock-1']);

    editMode.discard();
    assert.deepEqual(editMode.pendingRemovals, []);
  });

  test('are ignored outside edit mode', () => {
    const editMode = createEditMode({
      gridHandle: fakeGridHandle(),
      layoutClient: fakeLayoutClient(),
    });

    editMode.noteRemoval('clock-1');

    assert.deepEqual(editMode.pendingRemovals, []);
  });
});

describe('construction', () => {
  test('refuses to build without the pieces it drives', () => {
    assert.throws(() => createEditMode({ layoutClient: fakeLayoutClient() }), /gridHandle/);
    assert.throws(() => createEditMode({ gridHandle: fakeGridHandle() }), /layoutClient/);
  });
});
