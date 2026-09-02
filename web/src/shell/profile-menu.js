/**
 * The profile menu — where "Edit dashboard" went.
 *
 * ## Why the edit button moved
 *
 * It used to be the first thing on the page: a bare "Edit dashboard" button in
 * the top-left, above everything. The dashboard Haven replaces has no edit
 * affordance on the page at all — it is a dashboard, and the overwhelmingly
 * common thing to do with it is *look at it*. Giving the rarest action the
 * most prominent position on screen is backwards.
 *
 * So it lives behind a circular profile control at the right end of the
 * header, which is the conventional home for "things about this session"
 * and leaves room for the settings that will follow it.
 *
 * ## The keyboard contract, which is the whole reason this is a module
 *
 * A dropdown is trivial to build and easy to build wrongly. The rules here:
 *
 *  - the trigger is a real `<button>` with `aria-haspopup="menu"` and an
 *    `aria-expanded` that tracks the actual state
 *  - items are real `<button>`s in a `role="menu"`, so they are tab-reachable
 *    and announced as a menu rather than as loose text
 *  - **Escape closes and returns focus to the trigger.** Closing a menu and
 *    dropping focus to `<body>` strands a keyboard user at the top of the
 *    document with no idea where they are — it is the single most common way
 *    a menu like this is broken.
 *  - a click anywhere outside closes it, which is what a mouse user expects
 *    and what stops the menu shadowing the page indefinitely
 *  - choosing an item closes the menu FIRST, then runs the action, so an
 *    action that moves focus itself (entering edit mode) is not immediately
 *    overridden by the menu's own focus restoration
 *
 * The menu is hidden with the `hidden` property rather than a class, so it is
 * out of the accessibility tree as well as out of sight.
 */

/**
 * Builds the profile control and its dropdown.
 *
 * @param {object} [deps]
 * @param {string} [deps.label]  the accessible name of the trigger
 * @param {string} [deps.initial] the letter shown in the avatar circle
 * @param {Array<{id: string, label: string, onSelect: () => void}>} [deps.items]
 * @param {Document} [deps.document]
 * @returns {{el, trigger, menu, items, open, close, toggle, isOpen, destroy, setItemLabel}}
 */
export function createProfileMenu({
  label = 'Profile and settings',
  initial = 'O',
  items = [],
  document: doc = globalThis.document,
} = {}) {
  const el = doc.createElement('div');
  el.className = 'haven-profile';

  const trigger = doc.createElement('button');
  trigger.type = 'button';
  trigger.className = 'haven-profile__trigger';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', label);

  // The avatar is decorative — the button already carries the accessible name,
  // so announcing the letter too would just read a stray character.
  const avatar = doc.createElement('span');
  avatar.className = 'haven-profile__avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = String(initial).slice(0, 1).toUpperCase();
  trigger.appendChild(avatar);

  const menu = doc.createElement('div');
  menu.className = 'haven-profile__menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  menu.hidden = true;

  const built = new Map();

  for (const item of items) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'haven-profile__item';
    button.setAttribute('role', 'menuitem');
    button.textContent = item.label;
    if (item.id) button.dataset.itemId = item.id;
    button.addEventListener('click', () => {
      // Close BEFORE the action runs. `close()` restores focus to the trigger,
      // and an action that moves focus itself (edit mode) must win that race.
      close();
      item.onSelect?.();
    });
    menu.appendChild(button);
    if (item.id) built.set(item.id, button);
  }

  let open = false;

  function setOpen(next) {
    open = next;
    menu.hidden = !next;
    trigger.setAttribute('aria-expanded', String(next));
    el.classList?.toggle?.('haven-profile--open', next);
  }

  function openMenu() {
    if (open) return;
    setOpen(true);
    // Land on the first item, so the menu is usable without a mouse the
    // instant it appears.
    menu.children?.[0]?.focus?.();
  }

  function close({ restoreFocus = true } = {}) {
    if (!open) return;
    setOpen(false);
    if (restoreFocus) trigger.focus?.();
  }

  trigger.addEventListener('click', () => {
    if (open) close();
    else openMenu();
  });

  /**
   * Escape closes from anywhere inside the control.
   *
   * Bound on the wrapper rather than the document: the menu only needs to
   * handle Escape while focus is within it, and a document-level handler would
   * swallow Escape for the search palette and the settings panel too.
   */
  function onKeyDown(event) {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation?.();
    close();
  }
  el.addEventListener('keydown', onKeyDown);

  /**
   * A click outside closes it.
   *
   * `contains` is guarded because the test doubles do not implement it; a
   * missing `contains` must not turn every outside click into a crash.
   */
  function onDocumentClick(event) {
    if (!open) return;
    const target = event?.target;
    if (target && el.contains?.(target)) return;
    // No focus restoration: the user has just clicked somewhere else, and
    // yanking focus back to the trigger would undo their own click.
    close({ restoreFocus: false });
  }
  doc.addEventListener?.('click', onDocumentClick, true);

  el.append(trigger, menu);

  return {
    el,
    trigger,
    menu,
    items: built,
    get isOpen() {
      return open;
    },
    open: openMenu,
    close,
    toggle() {
      if (open) close();
      else openMenu();
    },
    /** Lets the toolbar's label ("Edit dashboard" / "Done editing") stay in sync. */
    setItemLabel(id, text) {
      const button = built.get(id);
      if (button) button.textContent = text;
      return button ?? null;
    },
    destroy() {
      doc.removeEventListener?.('click', onDocumentClick, true);
      el.removeEventListener?.('keydown', onKeyDown);
    },
  };
}

export default { createProfileMenu };
