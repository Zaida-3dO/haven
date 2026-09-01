import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { createHeader } from '../src/shell/header.js';

/**
 * A DOM double just large enough for the header.
 *
 * Same shape as `add-panel.test.js`'s: the shared `fake-dom.js` helper models
 * the widget host's needs, and widening it for one module's `append` would
 * make every other suite's failures point at the helper.
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

/** Every element in the tree, depth-first — the header nests three levels. */
function flatten(el, out = []) {
  out.push(el);
  for (const child of el.children ?? []) flatten(child, out);
  return out;
}

function find(header, className) {
  return flatten(header.el).find((el) => el.className === className);
}

/**
 * A fixed instant AND a fixed zone, so nothing here depends on the machine.
 *
 * The instant alone is not enough: these assertions first ran without a
 * `timeZone` and so formatted in whatever zone the runner was in. They passed
 * locally (BST, UTC+1 — "11:30") and failed in CI (UTC — "10:30"). The repo
 * already runs `calendar-group` under five zones for exactly this reason.
 */
const AT = new Date('2026-09-01T10:30:00Z');
const TZ = 'Europe/London';

function build(overrides = {}) {
  return createHeader({
    document: fakeDocument(),
    now: () => AT,
    locale: 'en-GB',
    timeZone: TZ,
    ...overrides,
  });
}

describe('the app header', () => {
  test('renders exactly one h1, carrying the product name', () => {
    const header = build({ title: 'Haven' });
    const headings = flatten(header.el).filter((el) => el.tagName === 'H1');

    // The page had NO h1 at all before this module existed, so a screen
    // reader landed on the dashboard with nothing naming it.
    assert.equal(headings.length, 1);
    assert.equal(headings[0].textContent, 'Haven');
  });

  test('the search control opens the palette rather than being an input', () => {
    let opened = 0;
    const header = build({ onSearch: () => (opened += 1) });
    const search = find(header, 'haven-header__search');

    // A BUTTON, not an INPUT: there is already one global search (SearchUI),
    // and a second real field would be a second search with its own bugs.
    assert.equal(search.tagName, 'BUTTON');
    assert.equal(search.attributes['aria-haspopup'], 'dialog');

    search.click();
    assert.equal(opened, 1);
  });

  test('the clock renders the injected instant, not the wall clock', () => {
    const header = build();

    assert.equal(find(header, 'haven-header__time').textContent, '11:30');
    assert.match(find(header, 'haven-header__date').textContent, /Tue/);
  });

  test('tick() re-reads the clock, so the minute can advance', () => {
    let at = new Date('2026-09-01T10:30:00Z');
    const header = createHeader({
      document: fakeDocument(),
      now: () => at,
      locale: 'en-GB',
      timeZone: TZ,
    });
    assert.equal(find(header, 'haven-header__time').textContent, '11:30');

    at = new Date('2026-09-01T10:31:00Z');
    header.tick();

    assert.equal(find(header, 'haven-header__time').textContent, '11:31');
  });

  test('the decorative mark is hidden from assistive tech', () => {
    const header = build({ title: 'Haven' });
    const mark = find(header, 'haven-header__mark');

    // It is the first letter of the name that is announced right beside it,
    // so announcing it too would just stutter.
    assert.equal(mark.attributes['aria-hidden'], 'true');
    assert.equal(mark.textContent, 'H');
  });

  test('destroy() stops the clock interval', () => {
    const cleared = [];
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    globalThis.setInterval = () => 'timer-1';
    globalThis.clearInterval = (id) => cleared.push(id);

    try {
      const header = build();
      header.destroy();
      // A boot torn down without this leaks one timer per boot.
      assert.deepEqual(cleared, ['timer-1']);
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  });
});
