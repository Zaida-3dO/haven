import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { MODE, createEditMode, createEditToolbar, layoutDiffers } from '../src/shell/edit-mode.js';
import { createFakeDocument } from './helpers/fake-dom.js';

/**
 * A stand-in for the handle `mountGrid` returns.
 *
 * It models the behaviours edit mode actually depends on: `extract` returns
 * the current geometry for a breakpoint, `applyLayout` puts a previous
 * geometry back — which is what Discard is — and `hasLayoutFor` reports
 * whether a breakpoint has ever been arranged.
 *
 * **`extract` deliberately reproduces GridStack's sharp edge.** The real
 * `grid.save(..., column)` substitutes the *rendered* column's geometry when
 * it holds no cached layout for the one asked for, rather than returning
 * nothing. Modelling that is what lets a test distinguish a guarded save from
 * an unguarded one — a fake that returned the requested breakpoint's nodes
 * regardless would pass whether or not the guard is wired in, which is exactly
 * the hole this suite previously had.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.arranged] breakpoints GridStack holds a layout for.
 *   Defaults to the rendered one, which is always live.
 */
function fakeGridHandle({ breakpoint = 'desktop', nodes = [], arranged } = {}) {
  const state = {
    breakpoint,
    nodes: [...nodes],
    editable: null,
    applied: [],
    classes: new Set(),
    arranged: new Set(arranged ?? [breakpoint]),
    extracted: [],
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
    hasLayoutFor: (bp) => state.arranged.has(bp),
    // Note the substitution: an unarranged breakpoint yields the RENDERED
    // column's geometry, just as GridStack does. Saving that is the bug.
    extract: (bp = state.breakpoint) => {
      state.extracted.push(bp);
      return state.nodes.map((n) => ({ ...n }));
    },
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

  // ── the guard against saving a breakpoint that was never arranged ──────
  //
  // `hasLayoutFor` (grid.js) wraps `hasCachedLayout` (grid-layout.js). It was
  // written, exported and unit-tested, but for a while NOTHING CALLED IT — the
  // save path extracted unconditionally. It was not corrupting layouts only
  // because save() sends the rendered breakpoint, which always passes the
  // guard; a "save both breakpoints" path would have landed the corruption
  // silently with the suite still green.
  //
  // These tests exist to fail if the guard call is deleted from save(). They
  // drive save() at a breakpoint GridStack holds no layout for, which is the
  // only situation where guarded and unguarded behaviour differ.

  test('refuses to save a breakpoint that has never been arranged', async () => {
    // Rendered at desktop; mobile has never been visited, so GridStack holds
    // no layout for its 4-column width. Extracting mobile here would hand back
    // the 12-column desktop geometry and persist it as the mobile layout.
    const gridHandle = fakeGridHandle({
      breakpoint: 'mobile',
      arranged: ['desktop'],
      nodes: [{ id: 'a', x: 9, y: 0, w: 3, h: 2 }],
    });
    const layoutClient = fakeLayoutClient();
    const editMode = createEditMode({ gridHandle, layoutClient });

    editMode.enter();
    await assert.rejects(() => editMode.save(), /never been arranged/);

    // The assertion that actually bites: nothing was written. Without the
    // guard this array holds one desktop-shaped mobile layout.
    assert.equal(layoutClient.saves.length, 0, 'an unarranged breakpoint must not be persisted');
  });

  test('does not even extract an unarranged breakpoint', async () => {
    // Guard before extract, not after: `extract` is the call that produces the
    // wrong geometry, so it must not run at all.
    const gridHandle = fakeGridHandle({ breakpoint: 'mobile', arranged: ['desktop'] });
    const editMode = createEditMode({ gridHandle, layoutClient: fakeLayoutClient() });

    editMode.enter();
    gridHandle.state.extracted.length = 0; // enter() snapshots; ignore that call
    await assert.rejects(() => editMode.save());

    assert.deepEqual(gridHandle.state.extracted, [], 'extract must not be reached');
  });

  test('a refused save stays in edit mode, so the arrangement is not lost', async () => {
    // Same reasoning as a failed network save: dropping to view mode would
    // look like success.
    const gridHandle = fakeGridHandle({ breakpoint: 'mobile', arranged: ['desktop'] });
    const editMode = createEditMode({ gridHandle, layoutClient: fakeLayoutClient() });

    editMode.enter();
    await assert.rejects(() => editMode.save());

    assert.equal(editMode.isEditing, true);
  });

  test('still saves once that breakpoint has actually been arranged', async () => {
    // The guard must not block the normal path — mobile arranged, mobile saved.
    const gridHandle = fakeGridHandle({
      breakpoint: 'mobile',
      arranged: ['desktop', 'mobile'],
      nodes: [{ id: 'a', x: 0, y: 0, w: 4, h: 2 }],
    });
    const layoutClient = fakeLayoutClient();
    const editMode = createEditMode({ gridHandle, layoutClient });

    editMode.enter();
    await editMode.save();

    assert.deepEqual(Object.keys(layoutClient.saves[0]), ['mobile']);
    assert.equal(editMode.mode, MODE.VIEW);
  });

  test('a handle with no hasLayoutFor is treated as arranged', async () => {
    // Back-compat: the guard is a defence, not a new required method on the
    // handle contract.
    const gridHandle = fakeGridHandle({ breakpoint: 'desktop' });
    delete gridHandle.hasLayoutFor;
    const layoutClient = fakeLayoutClient();
    const editMode = createEditMode({ gridHandle, layoutClient });

    editMode.enter();
    await editMode.save();

    assert.equal(layoutClient.saves.length, 1);
  });
});

describe('the edit toolbar', () => {
  /**
   * The toolbar had NO tests at all before this suite — `createEditToolbar`
   * appeared only in `boot.js` and its own module. That is how a Save button
   * that never greyed out, and a refused save that surfaced nothing, both
   * survived review: nothing could see them.
   */
  function build({ nodes = [{ id: 'a', x: 0, y: 0, w: 2, h: 2 }], fail = false } = {}) {
    const doc = createFakeDocument();
    const gridHandle = fakeGridHandle({ nodes });
    const layoutClient = fakeLayoutClient({ fail });
    const editMode = createEditMode({ gridHandle, layoutClient });
    const toolbar = createEditToolbar({ editMode, document: doc });
    return { toolbar, editMode, gridHandle, layoutClient };
  }

  /** Fire the click listener the toolbar registered, as the browser would. */
  const click = async (el) => {
    for (const handler of el.listeners.get('click') ?? []) await handler();
  };

  const move = (gridHandle) => {
    gridHandle.state.nodes = [{ id: 'a', x: 6, y: 4, w: 2, h: 2 }];
  };

  test('Save is marked aria-disabled, NOT disabled, so it stays focusable', () => {
    // The finding: a `disabled` button is not focusable, so the reason it is
    // inert is announced to nobody. Keeping the property off is the whole
    // fix — if it comes back, the explanation becomes unreachable again.
    const { toolbar, editMode } = build();

    editMode.enter();
    toolbar.sync();

    assert.equal(toolbar.save.getAttribute('aria-disabled'), 'true');
    assert.notEqual(toolbar.save.disabled, true, 'the disabled property must stay off');
  });

  test('an inert Save says why, in its accessible name and not only a tooltip', () => {
    const { toolbar, editMode } = build();

    editMode.enter();
    toolbar.sync();

    assert.equal(toolbar.save.getAttribute('title'), 'No changes to save');
    assert.match(toolbar.save.getAttribute('aria-label') ?? '', /no changes to save/i);
  });

  test('a dirty layout clears both the reason and the inert flag', () => {
    // The stale half: a hover must never claim there is nothing to save while
    // Save is live.
    const { toolbar, editMode, gridHandle } = build();

    editMode.enter();
    move(gridHandle);
    toolbar.sync();

    assert.equal(toolbar.save.getAttribute('aria-disabled'), 'false');
    assert.equal(toolbar.save.getAttribute('title'), null);
    assert.equal(toolbar.save.getAttribute('aria-label'), null);
  });

  test('clicking an inert Save saves nothing', async () => {
    // `aria-disabled` is advisory — the browser still fires the click, so the
    // no-op has to be enforced in JS. Without that, marking the button
    // aria-disabled instead of disabled would make a dead button live.
    const { toolbar, editMode, layoutClient } = build();

    editMode.enter();
    toolbar.sync();
    await click(toolbar.save);

    assert.equal(layoutClient.saves.length, 0);
    assert.equal(editMode.isEditing, true, 'a swallowed click must not leave edit mode');
  });

  test('a live Save still saves', async () => {
    // The other side of the swallow: it must not swallow everything.
    const { toolbar, editMode, gridHandle, layoutClient } = build();

    editMode.enter();
    move(gridHandle);
    toolbar.sync();
    await click(toolbar.save);

    assert.equal(layoutClient.saves.length, 1);
    assert.equal(editMode.isEditing, false);
  });

  test('a refused save surfaces the reason instead of rejecting unhandled', async () => {
    // Before the `catch`, the throw inside `save()` became an unhandled
    // rejection: the button appeared to work and nothing was persisted.
    const { toolbar, editMode, gridHandle } = build({ fail: true });

    editMode.enter();
    move(gridHandle);
    toolbar.sync();

    await assert.doesNotReject(async () => {
      await click(toolbar.save);
    });

    assert.match(toolbar.save.getAttribute('title') ?? '', /could not save/i);
    assert.match(toolbar.save.getAttribute('title') ?? '', /network down/);
    // Announced, not just hoverable — the same reason the inert state uses a
    // label rather than relying on `title`.
    assert.match(toolbar.save.getAttribute('aria-label') ?? '', /could not save/i);
    assert.equal(editMode.isEditing, true, 'a failed save must stay in edit mode');
  });

  test('the failure message does not outlive the failure', async () => {
    // `sync()` runs in the `finally` straight after the catch and rewrites
    // these very attributes, so the error has to be held and rendered rather
    // than written directly — otherwise it is stripped one line after it is
    // set. This asserts the other end: it must also GO when a retry works,
    // or the button accuses itself of a failure that has been fixed.
    const doc = createFakeDocument();
    const gridHandle = fakeGridHandle({ nodes: [{ id: 'a', x: 0, y: 0, w: 2, h: 2 }] });
    let fail = true;
    const layoutClient = {
      saves: [],
      async save(payload) {
        this.saves.push(payload);
        if (fail) throw new Error('network down');
        return { saved: Object.keys(payload) };
      },
    };
    const editMode = createEditMode({ gridHandle, layoutClient });
    const toolbar = createEditToolbar({ editMode, document: doc });

    editMode.enter();
    move(gridHandle);
    toolbar.sync();

    await click(toolbar.save);
    assert.match(toolbar.save.getAttribute('title') ?? '', /network down/);

    fail = false;
    await click(toolbar.save);

    // The retry succeeds and drops back to view mode, where Save is inert
    // again — so the title is the ordinary "nothing to save", NOT absent. The
    // claim being made is that no trace of the failure survives it.
    assert.doesNotMatch(
      toolbar.save.getAttribute('title') ?? '',
      /could not save|network down/i,
      'the stale failure must not outlive a successful retry'
    );
    assert.doesNotMatch(toolbar.save.getAttribute('aria-label') ?? '', /could not save/i);
    assert.equal(editMode.isEditing, false, 'the retry must actually save');
  });
});

describe('construction', () => {
  test('refuses to build without the pieces it drives', () => {
    assert.throws(() => createEditMode({ layoutClient: fakeLayoutClient() }), /gridHandle/);
    assert.throws(() => createEditMode({ gridHandle: fakeGridHandle() }), /layoutClient/);
  });
});

describe('layoutDiffers', () => {
  const at = (id, x, y) => ({ id, x, y, w: 2, h: 2 });

  test('a layout is not different from itself', () => {
    const nodes = [at('a', 0, 0), at('b', 2, 0)];
    assert.equal(
      layoutDiffers(
        nodes,
        nodes.map((n) => ({ ...n }))
      ),
      false
    );
  });

  test('a moved tile is a difference', () => {
    assert.equal(layoutDiffers([at('a', 0, 0)], [at('a', 3, 0)]), true);
  });

  test('a resized tile is a difference', () => {
    assert.equal(
      layoutDiffers([{ id: 'a', x: 0, y: 0, w: 2, h: 2 }], [{ id: 'a', x: 0, y: 0, w: 4, h: 2 }]),
      true
    );
  });

  test('reordering the array is NOT a difference', () => {
    // The trap this whole function exists for. `extract()` comes from
    // GridStack's `save()`, which returns nodes in engine order, and the
    // engine reorders as tiles move. Comparing by position — a
    // `JSON.stringify` of the two arrays, say — reports a change here, and
    // Save would light up on a layout nobody touched.
    const before = [at('a', 0, 0), at('b', 2, 0)];
    const after = [at('b', 2, 0), at('a', 0, 0)];

    assert.equal(layoutDiffers(before, after), false);
  });

  test('a tile moved and moved back is NOT a difference', () => {
    // The case a naive implementation fails: it is the *layout* that is
    // compared, not the history of how it got there. Dragging a widget across
    // the board and putting it back leaves nothing to save.
    const before = [at('a', 0, 0), at('b', 2, 0)];
    const moved = [at('a', 6, 4), at('b', 2, 0)];
    const back = [at('a', 0, 0), at('b', 2, 0)];

    assert.equal(layoutDiffers(before, moved), true);
    assert.equal(layoutDiffers(before, back), false);
  });

  test('a removed tile is a difference even though nothing moved', () => {
    const before = [at('a', 0, 0), at('b', 2, 0)];
    const after = [at('a', 0, 0)];

    assert.equal(layoutDiffers(before, after), true);
  });

  test('an added tile is a difference even though nothing moved', () => {
    const before = [at('a', 0, 0)];
    const after = [at('a', 0, 0), at('b', 2, 0)];

    assert.equal(layoutDiffers(before, after), true);
  });

  test('swapping one widget for another is a difference at the same geometry', () => {
    // Same length, same positions, different ids — caught only because the
    // lookup is by id. A length-and-geometry comparison would call this clean.
    assert.equal(layoutDiffers([at('a', 0, 0)], [at('c', 0, 0)]), true);
  });
});

describe('isDirty', () => {
  test('is false in view mode, where there is nothing to save', () => {
    const editMode = createEditMode({
      gridHandle: fakeGridHandle({ nodes: [{ id: 'a', x: 0, y: 0, w: 2, h: 2 }] }),
      layoutClient: fakeLayoutClient(),
    });

    assert.equal(editMode.isDirty, false);
  });

  test('is false on entering edit mode, before anything is touched', () => {
    const editMode = createEditMode({
      gridHandle: fakeGridHandle({ nodes: [{ id: 'a', x: 0, y: 0, w: 2, h: 2 }] }),
      layoutClient: fakeLayoutClient(),
    });

    editMode.enter();

    assert.equal(editMode.isDirty, false);
  });

  test('is true after a tile moves, and false again once it moves back', () => {
    const gridHandle = fakeGridHandle({ nodes: [{ id: 'a', x: 0, y: 0, w: 2, h: 2 }] });
    const editMode = createEditMode({ gridHandle, layoutClient: fakeLayoutClient() });

    editMode.enter();
    gridHandle.state.nodes = [{ id: 'a', x: 6, y: 4, w: 2, h: 2 }];
    assert.equal(editMode.isDirty, true);

    gridHandle.state.nodes = [{ id: 'a', x: 0, y: 0, w: 2, h: 2 }];
    assert.equal(editMode.isDirty, false);
  });

  test('is true after a removal, seen through the grid rather than a tally', () => {
    // Removals used to be tracked in a separate `removed` array that nothing
    // in the app ever wrote to, so this branch was unreachable in production
    // while looking covered. The array is gone; what makes a removal dirty is
    // that the tile is no longer among the grid's nodes, which is the same
    // thing `layoutDiffers` already uses for every other kind of change.
    //
    // Removing the SECOND tile leaves the first exactly where it was, so a
    // geometry-only comparison would call this clean. Only the node count and
    // the id check catch it.
    const gridHandle = fakeGridHandle({
      nodes: [
        { id: 'a', x: 0, y: 0, w: 2, h: 2 },
        { id: 'b', x: 2, y: 0, w: 2, h: 2 },
      ],
    });
    const editMode = createEditMode({ gridHandle, layoutClient: fakeLayoutClient() });

    editMode.enter();
    assert.equal(editMode.isDirty, false);

    gridHandle.state.nodes = [{ id: 'a', x: 0, y: 0, w: 2, h: 2 }];

    assert.equal(editMode.isDirty, true);
  });

  test('is false again after a save clears the session', async () => {
    const gridHandle = fakeGridHandle({ nodes: [{ id: 'a', x: 0, y: 0, w: 2, h: 2 }] });
    const editMode = createEditMode({ gridHandle, layoutClient: fakeLayoutClient() });

    editMode.enter();
    gridHandle.state.nodes = [{ id: 'a', x: 6, y: 4, w: 2, h: 2 }];
    await editMode.save();

    assert.equal(editMode.isDirty, false);
  });

  test('stays dirty when a save fails, because the changes are still unsaved', async () => {
    // Save leaves the session in edit mode on failure precisely so the
    // arrangement is not lost. A Save button that disabled itself on the way
    // out would strip the user of the retry.
    const gridHandle = fakeGridHandle({ nodes: [{ id: 'a', x: 0, y: 0, w: 2, h: 2 }] });
    const editMode = createEditMode({
      gridHandle,
      layoutClient: fakeLayoutClient({ fail: true }),
    });

    editMode.enter();
    gridHandle.state.nodes = [{ id: 'a', x: 6, y: 4, w: 2, h: 2 }];
    await assert.rejects(() => editMode.save(), /network down/);

    assert.equal(editMode.isDirty, true);
  });
});
