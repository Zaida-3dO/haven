import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { createProfileMenu } from '../src/shell/profile-menu.js';

/**
 * A DOM double just large enough for the profile menu.
 *
 * Same shape as `header.test.js`'s, plus the three things this module actually
 * needs and the header does not: `focus()` tracking (the whole point of the
 * Escape contract), `classList.toggle`, and a document-level `addEventListener`
 * so the outside-click handler has something to attach to.
 */
function fakeDocument() {
  const focused = [];

  const make = (tag) => ({
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    attributes: {},
    listeners: {},
    classes: new Set(),
    className: '',
    textContent: '',
    hidden: false,
    type: '',
    appendChild(child) {
      this.children.push(child);
      child.parent = this;
      return child;
    },
    append(...nodes) {
      for (const node of nodes) this.appendChild(node);
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    getAttribute(name) {
      return this.attributes[name];
    },
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
    },
    dispatch(type, event = {}) {
      for (const fn of this.listeners[type] ?? []) fn(event);
    },
    click() {
      this.dispatch('click', { preventDefault() {}, stopPropagation() {} });
    },
    focus() {
      focused.push(this);
    },
    /** Walks up `parent`, which is what the outside-click test exercises. */
    contains(node) {
      for (let cursor = node; cursor; cursor = cursor.parent) {
        if (cursor === this) return true;
      }
      return false;
    },
    classList: {
      toggle(name, on) {
        if (on) this.owner.classes.add(name);
        else this.owner.classes.delete(name);
      },
    },
  });

  const documentListeners = {};

  return {
    focused,
    documentListeners,
    createElement(tag) {
      const el = make(tag);
      el.classList.owner = el;
      return el;
    },
    addEventListener(type, fn) {
      (documentListeners[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      documentListeners[type] = (documentListeners[type] ?? []).filter((f) => f !== fn);
    },
    clickOutside(target) {
      for (const fn of documentListeners.click ?? []) fn({ target });
    },
  };
}

/** The menu under test, with one item whose selections are recorded. */
function build(doc = fakeDocument()) {
  const chosen = [];
  const menu = createProfileMenu({
    document: doc,
    items: [{ id: 'edit', label: 'Edit dashboard', onSelect: () => chosen.push('edit') }],
  });
  return { doc, menu, chosen };
}

describe('the profile menu', () => {
  test('starts closed, and says so to assistive tech', () => {
    const { menu } = build();

    assert.equal(menu.isOpen, false);
    assert.equal(menu.menu.hidden, true, 'a closed menu must be `hidden`, not merely unstyled');
    assert.equal(menu.trigger.getAttribute('aria-expanded'), 'false');
  });

  test('the trigger is a real button that announces it opens a menu', () => {
    // A div with a click handler is not keyboard-reachable and announces
    // nothing. These three attributes are what make it a menu button rather
    // than a mystery control.
    const { menu } = build();

    assert.equal(menu.trigger.tagName, 'BUTTON');
    assert.equal(menu.trigger.type, 'button');
    assert.equal(menu.trigger.getAttribute('aria-haspopup'), 'menu');
    assert.ok(menu.trigger.getAttribute('aria-label'), 'the trigger needs an accessible name');
  });

  test('clicking the trigger opens it and moves focus onto the first item', () => {
    // Opening a menu and leaving focus on the trigger means a keyboard user
    // has to arrow into it blind. Landing on the first item is what makes it
    // usable the instant it appears.
    const { doc, menu } = build();

    menu.trigger.click();

    assert.equal(menu.isOpen, true);
    assert.equal(menu.menu.hidden, false);
    assert.equal(menu.trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(doc.focused.at(-1), menu.items.get('edit'), 'focus should land on the first item');
  });

  test('clicking the trigger again closes it', () => {
    const { menu } = build();

    menu.trigger.click();
    menu.trigger.click();

    assert.equal(menu.isOpen, false);
    assert.equal(menu.menu.hidden, true);
  });

  test('choosing an item closes the menu and runs the action', () => {
    const { menu, chosen } = build();

    menu.trigger.click();
    menu.items.get('edit').click();

    assert.deepEqual(chosen, ['edit']);
    assert.equal(menu.isOpen, false, 'the menu must close when an item is chosen');
  });

  test('the menu closes BEFORE the action runs', () => {
    // `close()` restores focus to the trigger. An action that moves focus
    // itself — entering edit mode — must win that race, or the menu yanks
    // focus back out from under it. So closing has to happen first.
    const doc = fakeDocument();
    const order = [];
    const menu = createProfileMenu({
      document: doc,
      items: [
        {
          id: 'edit',
          label: 'Edit dashboard',
          onSelect: () => order.push(`action(open=${menu.isOpen})`),
        },
      ],
    });

    menu.trigger.click();
    menu.items.get('edit').click();

    assert.deepEqual(
      order,
      ['action(open=false)'],
      'the menu must already be closed by the time the action runs'
    );
  });

  test('Escape closes it AND returns focus to the trigger', () => {
    // The single most common way a menu like this is broken: it closes and
    // drops focus to `<body>`, stranding a keyboard user at the top of the
    // document with no idea where they are.
    const { doc, menu } = build();

    menu.trigger.click();
    doc.focused.length = 0;

    menu.el.dispatch('keydown', { key: 'Escape', stopPropagation() {} });

    assert.equal(menu.isOpen, false);
    assert.equal(doc.focused.at(-1), menu.trigger, 'focus must return to the trigger');
  });

  test('Escape while already closed does nothing', () => {
    // Otherwise the handler steals Escape from the search palette and the
    // settings panel, which are the other two things Escape has to close.
    const { doc, menu } = build();

    let stopped = false;
    menu.el.dispatch('keydown', { key: 'Escape', stopPropagation: () => (stopped = true) });

    assert.equal(stopped, false, 'a closed menu must let Escape through to other handlers');
    assert.equal(doc.focused.length, 0);
  });

  test('a key other than Escape is left alone', () => {
    const { menu } = build();
    menu.trigger.click();

    menu.el.dispatch('keydown', { key: 'a', stopPropagation() {} });

    assert.equal(menu.isOpen, true);
  });

  test('a click outside closes it without stealing focus back', () => {
    // The user has just clicked somewhere else. Pulling focus to the trigger
    // would undo their own click.
    const { doc, menu } = build();

    menu.trigger.click();
    doc.focused.length = 0;

    doc.clickOutside(doc.createElement('div'));

    assert.equal(menu.isOpen, false);
    assert.equal(doc.focused.length, 0, 'an outside click must not restore focus to the trigger');
  });

  test('a click INSIDE the menu does not close it', () => {
    const { doc, menu } = build();

    menu.trigger.click();
    doc.clickOutside(menu.items.get('edit'));

    assert.equal(menu.isOpen, true, 'a click on the menu itself is not an outside click');
  });

  test('items are real buttons in a role="menu"', () => {
    const { menu } = build();

    assert.equal(menu.menu.getAttribute('role'), 'menu');
    const item = menu.items.get('edit');
    assert.equal(item.tagName, 'BUTTON');
    assert.equal(item.getAttribute('role'), 'menuitem');
    assert.equal(item.textContent, 'Edit dashboard');
  });

  test('setItemLabel keeps the label in step with the mode', () => {
    // The toolbar toggle and this item drive the same mode, so whichever is
    // used, the other has to follow — or the menu offers to enter a mode you
    // are already in.
    const { menu } = build();

    menu.setItemLabel('edit', 'Done editing');
    assert.equal(menu.items.get('edit').textContent, 'Done editing');

    assert.equal(menu.setItemLabel('nope', 'x'), null, 'an unknown id is a no-op, not a throw');
  });

  test('destroy removes the document listener it added', () => {
    // A capture-phase document listener per boot is a real leak: it keeps the
    // whole menu closure alive after the element is gone.
    const { doc, menu } = build();

    assert.equal(doc.documentListeners.click?.length, 1);
    menu.destroy();
    assert.equal(doc.documentListeners.click?.length, 0);
  });
});
