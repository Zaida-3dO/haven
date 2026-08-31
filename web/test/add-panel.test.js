import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { buildInsertion, createAddPanel } from '../src/shell/add-panel.js';
import { WidgetRegistry } from '../src/shell/registry.js';
import { parseConfig } from '../src/shell/schema.js';
import { definition as clock } from '../src/widgets/clock/index.js';

/** A second widget, so "lists what is registered" is not a one-element test. */
const notes = Object.freeze({
  type: 'notes',
  name: 'Notes',
  defaultSize: { w: 4, h: 3 },
  minSize: { w: 2, h: 2 },
  configSchema: [{ key: 'title', type: 'text', default: 'Notes' }],
});

function registryWith(...definitions) {
  const registry = new WidgetRegistry();
  for (const d of definitions) registry.register(d);
  return registry;
}

/**
 * A DOM double just large enough for the panel.
 *
 * `test/helpers/fake-dom.js` models the host's needs; the panel additionally
 * sets `hidden`, `type`, attributes and click listeners, so this adds those
 * rather than widening a helper other tests depend on.
 */
function fakeDocument() {
  const make = (tag) => ({
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    attributes: {},
    listeners: {},
    className: '',
    textContent: '',
    hidden: false,
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = [...nodes];
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
    click() {
      for (const fn of this.listeners.click ?? []) fn();
    },
  });

  return { createElement: make };
}

/** Every add-button in the panel, in render order. */
function buttons(panel) {
  const list = panel.el.children.find((c) => c.className === 'haven-add-panel__list');
  return list.children.map((item) => item.children[0]);
}

describe('buildInsertion', () => {
  test('inserts at defaultSize with a config that already validates', () => {
    // The whole point of getStubConfig: a newly added widget WORKS, rather
    // than landing as an error card the user has to go and fix first.
    const registry = registryWith(clock);

    const insertion = buildInsertion(registry, 'clock');

    assert.deepEqual(insertion.size, { w: 3, h: 2 });
    assert.doesNotThrow(() => parseConfig(clock.configSchema, insertion.config));
  });

  test('carries minSize through, which becomes GridStack minW/minH', () => {
    const insertion = buildInsertion(registryWith(clock), 'clock');
    assert.deepEqual(insertion.minSize, { w: 2, h: 1 });
  });

  test('uses the mobile size on the mobile breakpoint', () => {
    const registry = registryWith(clock);

    assert.deepEqual(buildInsertion(registry, 'clock', 'mobile').size, { w: 4, h: 2 });
    assert.deepEqual(buildInsertion(registry, 'clock', 'desktop').size, { w: 3, h: 2 });
  });

  test('a widget with no mobileSize keeps its default size on mobile', () => {
    const registry = registryWith(notes);
    assert.deepEqual(buildInsertion(registry, 'notes', 'mobile').size, { w: 4, h: 3 });
  });

  test('a widget shipping no getStubConfig still gets schema defaults', () => {
    const insertion = buildInsertion(registryWith(notes), 'notes');
    assert.equal(insertion.config.title, 'Notes');
  });

  test('returns null for an unknown type rather than throwing', () => {
    assert.equal(buildInsertion(registryWith(clock), 'nope'), null);
  });
});

describe('createAddPanel', () => {
  test('lists registered widgets by name, not by registry type', () => {
    const panel = createAddPanel({
      registry: registryWith(clock, notes),
      document: fakeDocument(),
    });
    panel.open();

    assert.deepEqual(
      buttons(panel).map((b) => b.textContent),
      ['Clock', 'Notes']
    );
  });

  test('clicking an entry emits an insertion for that widget', () => {
    const added = [];
    const panel = createAddPanel({
      registry: registryWith(clock, notes),
      onAdd: (insertion) => added.push(insertion),
      document: fakeDocument(),
    });
    panel.open();

    buttons(panel)[1].click();

    assert.equal(added.length, 1);
    assert.equal(added[0].type, 'notes');
  });

  test('inserts at the size of the breakpoint currently being edited', () => {
    const added = [];
    const panel = createAddPanel({
      registry: registryWith(clock),
      onAdd: (insertion) => added.push(insertion),
      breakpoint: () => 'mobile',
      document: fakeDocument(),
    });
    panel.open();

    buttons(panel)[0].click();

    assert.deepEqual(added[0].size, { w: 4, h: 2 });
  });

  test('opens and closes, and starts closed', () => {
    const panel = createAddPanel({ registry: registryWith(clock), document: fakeDocument() });

    assert.equal(panel.isOpen, false);
    panel.open();
    assert.equal(panel.isOpen, true);
    panel.close();
    assert.equal(panel.isOpen, false);
  });

  test('re-reads the registry on each open, so a late widget appears', () => {
    const registry = registryWith(clock);
    const panel = createAddPanel({ registry, document: fakeDocument() });

    panel.open();
    assert.equal(buttons(panel).length, 1);

    registry.register(notes);
    panel.close();
    panel.open();

    assert.equal(buttons(panel).length, 2);
  });

  test('says so when nothing is registered instead of rendering an empty list', () => {
    const panel = createAddPanel({ registry: new WidgetRegistry(), document: fakeDocument() });
    panel.open();

    const list = panel.el.children.find((c) => c.className === 'haven-add-panel__list');
    assert.equal(list.children[0].className, 'haven-add-panel__empty');
  });

  test('is announced as a labelled dialog', () => {
    const panel = createAddPanel({ registry: registryWith(clock), document: fakeDocument() });

    assert.equal(panel.el.getAttribute('role'), 'dialog');
    assert.equal(panel.el.getAttribute('aria-label'), 'Add widget');
  });

  test('every entry is a real button, so the panel is keyboard-reachable', () => {
    const panel = createAddPanel({
      registry: registryWith(clock, notes),
      document: fakeDocument(),
    });
    panel.open();

    for (const button of buttons(panel)) {
      assert.equal(button.tagName, 'BUTTON');
      assert.equal(button.type, 'button');
    }
  });
});
