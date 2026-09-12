/**
 * Edit mode vs view mode (DESIGN §7).
 *
 * **View mode is the default and nothing moves in it.** Everything is
 * interactive: you click a torrent, you scroll a calendar. Dragging is off.
 *
 * **Edit mode** turns on drag handles and resize grips, dims widget content
 * and makes it non-interactive (so clicking a widget selects it rather than
 * activating whatever is under the cursor), opens the add-widget panel, and
 * gives every widget a settings gear and a remove button.
 *
 * Two decisions worth not relitigating:
 *
 *  - **Explicit toggle, not always-on dragging.** Always-on means an
 *    accidental drag every time you try to interact with widget content.
 *  - **Explicit Save/Discard, not autosave.** Discard restores the layout
 *    exactly as it was on entry, which is only possible because entry
 *    snapshots it. Autosave has no such point to return to.
 *
 * Desktop and mobile are edited separately — a session only ever saves the
 * breakpoint it is actually looking at, because deriving one from the other is
 * rejected by DESIGN §3.
 */

/** Which layout state a session is in. */
export const MODE = Object.freeze({ VIEW: 'view', EDIT: 'edit' });

/**
 * Snapshots the current breakpoint's layout so Discard has something to
 * restore. Taken on entry to edit mode, never later.
 */
export function snapshotLayout(gridHandle, breakpoint) {
  return {
    breakpoint,
    nodes: gridHandle.extract(breakpoint),
  };
}

/**
 * Whether a layout differs from the one snapshotted on entry.
 *
 * Pure, and exported, so the rule can be tested without a grid or a DOM.
 *
 * ## The three things this has to get right
 *
 * **Compare by id, not by array position.** `extract()` ultimately comes from
 * GridStack's `save()`, which returns nodes in engine order — and the engine
 * reorders as tiles move. A `JSON.stringify` comparison of the two arrays
 * therefore reports a difference when two tiles merely swapped places in the
 * list without either one moving on screen, which would light up Save on a
 * layout nobody touched.
 *
 * **Only geometry counts.** `x`, `y`, `w`, `h` are what a layout save
 * persists, so they are the whole of what "changed" can mean here. Anything
 * else `extract()` carries along (`widgetId`) is identity, not position.
 *
 * **A removal is a change even when nothing moved**, which is why the count is
 * compared and ids are checked in both directions rather than just iterating
 * the current nodes. Removing a tile from the bottom-right corner may leave
 * every other tile exactly where it was.
 *
 * @param {Array<object>} snapshotNodes  geometry as it was on entry
 * @param {Array<object>} currentNodes   geometry now
 * @returns {boolean}
 */
export function layoutDiffers(snapshotNodes, currentNodes) {
  const before = Array.isArray(snapshotNodes) ? snapshotNodes : [];
  const after = Array.isArray(currentNodes) ? currentNodes : [];

  // A widget added or removed is a change regardless of geometry.
  if (before.length !== after.length) return true;

  const byId = new Map(before.map((n) => [String(n.id), n]));

  for (const node of after) {
    const previous = byId.get(String(node.id));
    // An id present now but not on entry — an add, or a swap for a different
    // widget. Either way the layout is not the one that was snapshotted.
    if (!previous) return true;
    if (
      (previous.x ?? 0) !== (node.x ?? 0) ||
      (previous.y ?? 0) !== (node.y ?? 0) ||
      (previous.w ?? 1) !== (node.w ?? 1) ||
      (previous.h ?? 1) !== (node.h ?? 1)
    ) {
      return true;
    }
  }

  // Lengths match and every current id was found in the snapshot, so the two
  // id sets are equal and nothing needs checking in the other direction.
  return false;
}

/**
 * Creates the edit-mode controller.
 *
 * @param {object} deps
 * @param {object} deps.gridHandle    the handle returned by `mountGrid`
 * @param {object} deps.layoutClient  the client from `layout-client.js`
 * @param {object} [deps.addPanel]    the add-widget panel (`add-panel.js`)
 * @param {(mode: string) => void} [deps.onModeChange]
 * @param {(err: Error) => void} [deps.onError]
 */
export function createEditMode({
  gridHandle,
  layoutClient,
  addPanel = null,
  onModeChange = () => {},
  onError = () => {},
} = {}) {
  if (!gridHandle) throw new Error('createEditMode: gridHandle is required');
  if (!layoutClient) throw new Error('createEditMode: layoutClient is required');

  let mode = MODE.VIEW;
  let snapshot = null;

  const setMode = (next) => {
    mode = next;
    const editing = next === MODE.EDIT;

    gridHandle.setEditable(editing);
    gridHandle.root.classList.toggle('haven-grid--edit-mode', editing);

    // Widget content dims and stops being interactive in edit mode, so a
    // click selects the widget rather than activating what is inside it.
    for (const el of gridHandle.root.querySelectorAll('.haven-widget__body')) {
      el.toggleAttribute('inert', editing);
      el.setAttribute('aria-hidden', editing ? 'true' : 'false');
    }

    // Per-widget controls are only reachable in edit mode — including by
    // keyboard, which is why this toggles the tab stop and not just display.
    for (const el of gridHandle.root.querySelectorAll('.haven-widget__control')) {
      el.disabled = !editing;
      el.tabIndex = editing ? 0 : -1;
    }

    if (addPanel) editing ? addPanel.open() : addPanel.close();

    onModeChange(next);
  };

  /**
   * Whether a breakpoint may be extracted at all — see `hasCachedLayout` in
   * grid-layout.js for the GridStack behaviour this exists to defend against.
   *
   * A handle that does not implement `hasLayoutFor` is treated as arranged, so
   * this cannot make an otherwise-working handle unsaveable.
   */
  const canSave = (breakpoint) =>
    typeof gridHandle.hasLayoutFor !== 'function' || gridHandle.hasLayoutFor(breakpoint);

  return {
    get mode() {
      return mode;
    },

    get isEditing() {
      return mode === MODE.EDIT;
    },

    /**
     * Whether this session has anything to save.
     *
     * Drives the Save button's `disabled` state — a Save that is inert when
     * there is nothing to save says "you have no unsaved work" without the
     * user having to press it and find out.
     *
     * **False outside edit mode**, where there is no snapshot to compare
     * against and Save is not reachable anyway.
     *
     * **A removal needs no separate tracking**, which is worth stating
     * because it used to have some. A removed widget is deleted server-side
     * the moment it is clicked (`boot.js` → `instancesClient.remove` →
     * `instances-store.delete`, which calls `pruneLayoutReferences` and drops
     * the layout node across every breakpoint inside the same transaction).
     * There is nothing about the removal itself left for a layout save to
     * persist. What a save DOES still owe is the reflow it caused — the
     * surviving tiles' geometry — and `layoutDiffers` sees that through the
     * node count and the id comparison, with no help needed.
     *
     * **An addition counts too**, and that one is a judgement call worth
     * stating. A widget added during the session is persisted eagerly over the
     * instances API (`boot.js`), so its *existence* survives a refresh without
     * a layout save — but its *position* does not. Leaving Save disabled after
     * an add would strand the new tile's geometry, and the user would have no
     * way to tell that half of what they just did was unsaved. `layoutDiffers`
     * sees the new id and reports dirty, which is the behaviour we want.
     */
    get isDirty() {
      if (mode !== MODE.EDIT || !snapshot) return false;
      return layoutDiffers(snapshot.nodes, gridHandle.extract(gridHandle.breakpoint()));
    },

    /**
     * Enters edit mode, snapshotting the current breakpoint so Discard can
     * restore it.
     */
    enter() {
      if (mode === MODE.EDIT) return;
      snapshot = snapshotLayout(gridHandle, gridHandle.breakpoint());
      setMode(MODE.EDIT);
    },

    /**
     * Saves the edited breakpoint and returns to view mode.
     *
     * **Only the edited breakpoint is sent.** The layout API leaves any
     * breakpoint absent from a PUT untouched, so editing desktop cannot
     * clobber a mobile layout that was arranged separately.
     *
     * **Every breakpoint is guarded before it is extracted.** `extract` is
     * only meaningful for a breakpoint GridStack actually holds a layout for;
     * for any other, `grid.save(..., column)` silently returns the geometry of
     * the column currently rendered, which would persist desktop geometry into
     * the mobile row — the auto-reflow DESIGN §3 rejects. Today the only
     * breakpoint saved is the rendered one, which always passes; the guard is
     * here so that stays true if a "save both breakpoints" path is ever added.
     */
    async save() {
      if (mode !== MODE.EDIT) return null;

      const breakpoint = gridHandle.breakpoint();
      if (!canSave(breakpoint)) {
        throw new Error(
          `createEditMode.save: refusing to save the ${breakpoint} breakpoint, ` +
            'which has never been arranged — GridStack would substitute the rendered column.'
        );
      }
      const nodes = gridHandle.extract(breakpoint);

      try {
        const result = await layoutClient.save({ [breakpoint]: nodes });
        snapshot = null;
        setMode(MODE.VIEW);
        return result;
      } catch (err) {
        // Staying in edit mode on failure is deliberate: dropping to view mode
        // would look like a successful save and lose the arrangement.
        onError(err);
        throw err;
      }
    },

    /**
     * Discards every change made this session, restoring the layout as it was
     * on entry, and returns to view mode.
     */
    discard() {
      if (mode !== MODE.EDIT) return;

      if (snapshot) gridHandle.applyLayout(snapshot.nodes);

      snapshot = null;
      setMode(MODE.VIEW);
    },

    /**
     * Toggles between the two modes. Discards on exit — Save is explicit.
     *
     * Note what Discard does NOT undo: a widget removed this session is
     * already gone server-side (see `isDirty`), so Discard restores the
     * geometry of what remains and cannot bring it back. That asymmetry is
     * why removals are not modelled as pending changes.
     */
    toggle() {
      if (mode === MODE.EDIT) this.discard();
      else this.enter();
    },
  };
}

/**
 * Builds the edit-mode toolbar: the mode toggle plus Save/Discard.
 *
 * Everything here is a real `<button>` rather than a styled div, which is what
 * makes the whole toolbar keyboard-reachable without any extra key handling.
 *
 * ## Why the whole bar is hidden in view mode
 *
 * "Edit dashboard" used to be the first thing on the page — a button floating
 * above the dashboard, given the most prominent position on screen for the
 * rarest action. It has moved into the header's profile menu (see
 * `profile-menu.js`), and the toolbar now appears ONLY while editing, where
 * Save and Discard are the two things you actually need.
 *
 * The `toggle` button is kept and still works: it becomes "Done editing"
 * inside edit mode, so there is a way out of edit mode that does not require
 * finding the profile menu again. It is simply never visible in view mode,
 * because in view mode the whole bar is not.
 *
 * `bar.hidden` rather than a class, so the toolbar leaves the accessibility
 * tree in view mode instead of offering three unreachable buttons to a screen
 * reader.
 */
export function createEditToolbar({ editMode, document: doc = globalThis.document } = {}) {
  const bar = doc.createElement('div');
  bar.className = 'haven-toolbar';

  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'haven-toolbar__toggle';
  toggle.textContent = 'Edit dashboard';
  toggle.setAttribute('aria-pressed', 'false');

  const save = doc.createElement('button');
  save.type = 'button';
  save.className = 'haven-toolbar__save';
  save.textContent = 'Save';
  save.hidden = true;

  const discard = doc.createElement('button');
  discard.type = 'button';
  discard.className = 'haven-toolbar__discard';
  discard.textContent = 'Discard';
  discard.hidden = true;

  toggle.addEventListener('click', () => {
    if (editMode.isEditing) editMode.discard();
    else editMode.enter();
    sync();
  });

  /**
   * The message from the last failed save, or null.
   *
   * It lives out here rather than being written straight onto the button
   * because `sync()` runs in the `finally` immediately afterwards and rewrites
   * exactly those attributes — a failed save leaves the layout dirty, so
   * `sync()` would take the "live" branch and strip the explanation one line
   * after it was set. Holding the error and letting `sync()` render it keeps
   * one writer for the button's accessible state.
   */
  let saveError = null;

  save.addEventListener('click', async () => {
    // The button stays focusable and keeps its `click` when there is nothing
    // to save (see `sync()`), so the no-op has to be enforced here rather
    // than by the browser. Returning before `sync()` is deliberate: nothing
    // has changed, so there is nothing to re-render.
    if (save.getAttribute('aria-disabled') === 'true') return;

    // A new attempt supersedes the previous failure, so the stale message
    // cannot outlive the thing it described.
    saveError = null;

    try {
      await editMode.save();
    } catch (err) {
      /**
       * Without this `catch` a refused save is an unhandled rejection: the
       * button appears to work and the layout is silently not persisted.
       *
       * Two things reject here, not one. `save()` throws outright for a
       * breakpoint GridStack has never arranged — latent today, because only
       * the rendered breakpoint is ever saved, and armed the moment anyone
       * saves both at once. It ALSO re-throws after `onError` when the
       * layout PUT itself fails, which is reachable right now on any network
       * or server error.
       *
       * The message is surfaced on the button rather than in an `alert`, so
       * the failure is reported where the failing control is.
       */
      saveError = err?.message ?? String(err);
      console.error('Haven: saving the layout failed.', err);
    } finally {
      sync();
    }
  });

  discard.addEventListener('click', () => {
    editMode.discard();
    sync();
  });

  function sync() {
    const editing = editMode.isEditing;
    toggle.setAttribute('aria-pressed', String(editing));
    toggle.textContent = editing ? 'Done editing' : 'Edit dashboard';
    save.hidden = !editing;
    discard.hidden = !editing;

    /**
     * Save is inert until there is something to save.
     *
     * **Inert, not hidden.** The button keeps its place in the toolbar. A Save
     * that disappears and reappears as you drag tiles around is a moving
     * target, and its absence reads as "this dashboard cannot be saved"
     * rather than "there is nothing to save yet".
     *
     * **`aria-disabled`, NOT the `disabled` property**, and that is the whole
     * point of this block. A `disabled` button is removed from the tab order,
     * so it can never be focused — which means the explanation for why it is
     * inert is announced to nobody using a keyboard or a screen reader, and
     * `title` alone is a mouse-only affordance. Keeping the button focusable
     * and marking it `aria-disabled` leaves the reason reachable: the label
     * itself carries it, so focusing Save says "Save — no changes to save"
     * instead of an unexplained dead control.
     *
     * The cost is that the click must be swallowed in JS, because
     * `aria-disabled` is advisory and the browser still fires the event. The
     * handler above does that.
     *
     * Both the label and the `title` are CLEARED rather than left stale when
     * the layout is dirty, so neither ever claims there is nothing to save
     * while Save is live.
     *
     * Three states, in priority order: a failed save explains itself, an
     * inert Save explains itself, and a live Save says nothing beyond its own
     * text. The failure wins over "live" because a dirty layout is exactly
     * what a failed save leaves behind — reporting only "there is something
     * to save" would drop the news that saving it just failed.
     */
    const dirty = editMode.isDirty;
    save.setAttribute('aria-disabled', String(!dirty));

    if (saveError) {
      save.setAttribute('title', `Could not save: ${saveError}`);
      save.setAttribute('aria-label', `Save — could not save: ${saveError}`);
    } else if (dirty) {
      save.removeAttribute('title');
      save.removeAttribute('aria-label');
    } else {
      save.setAttribute('title', 'No changes to save');
      save.setAttribute('aria-label', 'Save — no changes to save');
    }

    // The bar itself only exists while editing — see the note above.
    bar.hidden = !editing;
  }

  bar.append(toggle, save, discard);
  sync();

  return { el: bar, toggle, save, discard, sync };
}

/**
 * Builds the per-widget edit controls — a settings gear and a remove button.
 *
 * Both are buttons with real labels, so a screen reader announces which widget
 * they belong to rather than reading out two anonymous icons.
 */
export function createWidgetControls({
  widgetId,
  title = widgetId,
  onSettings = () => {},
  onRemove = () => {},
  document: doc = globalThis.document,
} = {}) {
  const wrap = doc.createElement('div');
  wrap.className = 'haven-widget__controls';

  const gear = doc.createElement('button');
  gear.type = 'button';
  gear.className = 'haven-widget__control haven-widget__control--settings';
  gear.setAttribute('aria-label', `Settings for ${title}`);
  gear.textContent = 'Settings';
  gear.disabled = true;
  gear.tabIndex = -1;
  gear.addEventListener('click', () => onSettings(widgetId));

  const remove = doc.createElement('button');
  remove.type = 'button';
  remove.className = 'haven-widget__control haven-widget__control--remove';
  remove.setAttribute('aria-label', `Remove ${title}`);
  remove.textContent = 'Remove';
  remove.disabled = true;
  remove.tabIndex = -1;
  remove.addEventListener('click', () => onRemove(widgetId));

  wrap.append(gear, remove);
  return { el: wrap, gear, remove };
}
