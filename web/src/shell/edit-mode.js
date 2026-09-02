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
     */
    async save() {
      if (mode !== MODE.EDIT) return null;

      const breakpoint = gridHandle.breakpoint();
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
