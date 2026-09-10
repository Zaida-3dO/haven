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
  let removed = [];

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

    /** Widgets removed this session, pending Save. Empty outside edit mode. */
    get pendingRemovals() {
      return [...removed];
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
     * **A pending removal counts even with no geometry change.** `removed` is
     * tracked separately from the grid's own nodes, so a session whose only
     * act was removing a widget must still be dirty — reporting it clean is
     * strictly worse than the old always-enabled button, because it actively
     * tells the user their change is already saved.
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
      if (removed.length > 0) return true;
      return layoutDiffers(snapshot.nodes, gridHandle.extract(gridHandle.breakpoint()));
    },

    /**
     * Enters edit mode, snapshotting the current breakpoint so Discard can
     * restore it.
     */
    enter() {
      if (mode === MODE.EDIT) return;
      snapshot = snapshotLayout(gridHandle, gridHandle.breakpoint());
      removed = [];
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
        removed = [];
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
      removed = [];
      setMode(MODE.VIEW);
    },

    /** Toggles between the two modes. Discards on exit — Save is explicit. */
    toggle() {
      if (mode === MODE.EDIT) this.discard();
      else this.enter();
    },

    /** Records a widget removal so Save can act on it. */
    noteRemoval(widgetId) {
      if (mode === MODE.EDIT && widgetId) removed.push(widgetId);
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

  save.addEventListener('click', async () => {
    try {
      await editMode.save();
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
     * **`disabled`, not `hidden`.** The button keeps its place in the toolbar
     * and greys out. A Save that disappears and reappears as you drag tiles
     * around is a moving target, and its absence reads as "this dashboard
     * cannot be saved" rather than "there is nothing to save yet".
     *
     * The `title` is the only thing that explains *why* it is inert — a
     * disabled button is otherwise silent about it. It is cleared rather than
     * left stale when the layout is dirty, so a hover never claims there is
     * nothing to save while Save is live.
     */
    const dirty = editMode.isDirty;
    save.disabled = !dirty;
    if (dirty) save.removeAttribute('title');
    else save.setAttribute('title', 'No changes to save');

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
