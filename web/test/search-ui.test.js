import test from 'node:test';
import assert from 'node:assert/strict';

import { SearchIndex } from '../src/shell/search-index.js';
import { SearchUI, isOpenShortcut, defaultActionFor } from '../src/shell/search-ui.js';
import { createFakeDocument, FakeElement } from './helpers/fake-dom.js';

/** Invented fixtures — plausible results, nobody's real data. */
const APPS = [
  {
    id: 'app-reader',
    title: 'Reader',
    subtitle: 'Articles and bookmarks',
    url: 'https://reader.example.invalid/',
    keywords: ['articles'],
  },
  {
    id: 'app-notes',
    title: 'Notes',
    subtitle: 'Scratchpad',
    url: 'https://notes.example.invalid/',
  },
];

const CALENDAR = [
  { id: 'evt-1', title: 'Reading group', subtitle: 'Thursday 19:00', keywords: ['books'] },
];

const ALERTS = [{ id: 'alert-1', title: 'Read the release notes', subtitle: 'Update available' }];

function setup({ seed = true, ...options } = {}) {
  const index = new SearchIndex();
  if (seed) {
    index.setEntries('apps-1', APPS, { label: 'Apps' });
    index.setEntries('calendar-1', CALENDAR, { label: 'Calendar' });
    index.setEntries('alerts-1', ALERTS, { label: 'Alerts' });
  }

  const document = createFakeDocument();
  const navigated = [];
  const opened = [];
  const ui = new SearchUI(index, {
    documentRef: document,
    navigateToWidget: (widgetId, entry) => navigated.push({ widgetId, entry }),
    openUrl: (url, entry) => opened.push({ url, entry }),
    ...options,
  });

  const container = new FakeElement('div');
  container.ownerDocument = document;
  ui.mount(container);
  return { ui, index, document, container, navigated, opened };
}

/** A keydown event double with the spy `preventDefault` the UI calls. */
function key(name, extra = {}) {
  let prevented = false;
  return {
    key: name,
    preventDefault: () => (prevented = true),
    get defaultPrevented() {
      return prevented;
    },
    ...extra,
  };
}

const optionTitles = (ui) => ui.options.map((o) => o.entry.title);

// ── The shortcut ──────────────────────────────────────────────────────────

test('Ctrl-K and Cmd-K are the open shortcut; a bare K is not', () => {
  assert.equal(isOpenShortcut({ key: 'k', ctrlKey: true }), true);
  assert.equal(isOpenShortcut({ key: 'k', metaKey: true }), true);
  assert.equal(isOpenShortcut({ key: 'K', metaKey: true }), true, 'capital K counts');
  assert.equal(isOpenShortcut({ key: 'k' }), false, 'a bare k is someone typing');
  assert.equal(isOpenShortcut({ key: 'j', ctrlKey: true }), false);
  assert.equal(isOpenShortcut(null), false);
});

test('the shortcut opens the palette from anywhere on the page', () => {
  const { ui, document } = setup();
  ui.attachShortcut();
  assert.equal(ui.isOpen, false);

  const event = key('k', { ctrlKey: true });
  document.dispatchEvent({ type: 'keydown', ...event });

  assert.equal(ui.isOpen, true);
  assert.equal(event.defaultPrevented, true, 'must not fall through to the browser');
});

test('Escape from a document-level keypress closes the palette', () => {
  const { ui, document } = setup();
  ui.attachShortcut();
  ui.open();
  document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(ui.isOpen, false);
});

test('destroy unhooks the global shortcut', () => {
  const { ui, document } = setup();
  ui.attachShortcut();
  ui.destroy();
  document.dispatchEvent({ type: 'keydown', key: 'k', ctrlKey: true, preventDefault() {} });
  assert.equal(ui.isOpen, false);
});

// ── Combobox semantics ────────────────────────────────────────────────────

test('the input carries combobox semantics', () => {
  const { ui } = setup();
  const input = ui.input;
  assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.equal(input.getAttribute('aria-controls'), 'haven-search-listbox');
  assert.equal(input.getAttribute('aria-autocomplete'), 'list');
});

test('aria-expanded tracks whether the palette is open', () => {
  const { ui } = setup();
  ui.open();
  assert.equal(ui.input.getAttribute('aria-expanded'), 'true');
  ui.close();
  assert.equal(ui.input.getAttribute('aria-expanded'), 'false');
});

test('the palette is hidden until it is opened', () => {
  const { ui } = setup();
  assert.equal(ui.root.hasAttribute('hidden'), true);
  ui.open();
  assert.equal(ui.root.hasAttribute('hidden'), false);
  ui.close();
  assert.equal(ui.root.hasAttribute('hidden'), true);
});

test('opening focuses the input, and closing hands focus back', () => {
  const { ui, document } = setup();
  const before = new FakeElement('button');
  before.ownerDocument = document;
  before.focus();
  assert.equal(document.activeElement, before);

  ui.open();
  assert.equal(document.activeElement, ui.input, 'the next keystroke is a letter');

  ui.close();
  assert.equal(document.activeElement, before, 'focus must not be dumped at the document top');
});

test('aria-activedescendant points at the highlighted option, and focus stays in the input', () => {
  const { ui, document } = setup();
  ui.open();
  ui.setQuery('read');

  const first = ui.input.getAttribute('aria-activedescendant');
  assert.ok(first, 'an option is active as soon as there are results');
  assert.equal(document.activeElement, ui.input, 'focus never leaves the input');

  ui.move(1);
  assert.notEqual(ui.input.getAttribute('aria-activedescendant'), first);
  assert.equal(document.activeElement, ui.input);
});

test('the active option is the one marked aria-selected', () => {
  const { ui } = setup();
  ui.open();
  ui.setQuery('read');
  ui.move(1);

  const options = ui.root.querySelectorAll('[data-result-index]');
  const selected = options.filter((o) => o.getAttribute('aria-selected') === 'true');
  assert.equal(selected.length, 1, 'exactly one option is selected at a time');
  assert.equal(selected[0].id, ui.input.getAttribute('aria-activedescendant'));
});

test('options and groups carry listbox roles', () => {
  const { ui } = setup();
  ui.open();
  ui.setQuery('read');

  const listbox = ui.root.querySelector('.haven-search__results');
  assert.equal(listbox.getAttribute('role'), 'listbox');

  const groups = ui.root.querySelectorAll('.haven-search__group');
  assert.ok(groups.length > 0);
  for (const group of groups) {
    assert.equal(group.getAttribute('role'), 'group');
    assert.ok(group.getAttribute('aria-labelledby'), 'a group names itself for a screen reader');
  }

  for (const option of ui.root.querySelectorAll('[data-result-index]')) {
    assert.equal(option.getAttribute('role'), 'option');
  }
});

// ── Grouping ──────────────────────────────────────────────────────────────

test('results are grouped by source widget, and the group is labelled', () => {
  const { ui } = setup();
  ui.open();
  ui.setQuery('read');

  const labels = ui.groups.map((g) => g.label);
  assert.deepEqual([...labels].sort(), ['Alerts', 'Apps', 'Calendar']);

  // The label is rendered, so the origin of a result is never ambiguous.
  const rendered = ui.root
    .querySelectorAll('.haven-search__group-label')
    .map((el) => el.textContent);
  assert.deepEqual([...rendered].sort(), ['Alerts', 'Apps', 'Calendar']);
});

test('every rendered option belongs to the group it is drawn under', () => {
  const { ui } = setup();
  ui.open();
  ui.setQuery('read');

  for (const group of ui.groups) {
    for (const entry of group.results) {
      assert.equal(entry.widgetId, group.widgetId);
    }
  }
});

// ── Keyboard navigation ───────────────────────────────────────────────────

test('the first result is preselected so Enter does the obvious thing', () => {
  const { ui } = setup();
  ui.open();
  ui.setQuery('read');
  assert.equal(ui.activeIndex, 0);
});

test('arrows move down and up through the flattened result list', () => {
  const { ui } = setup();
  ui.open();
  ui.setQuery('read');
  const titles = optionTitles(ui);
  assert.ok(titles.length >= 3, 'need several results to walk');

  ui.handleKeydown(key('ArrowDown'));
  assert.equal(ui.activeOption.entry.title, titles[1]);
  ui.handleKeydown(key('ArrowDown'));
  assert.equal(ui.activeOption.entry.title, titles[2]);
  ui.handleKeydown(key('ArrowUp'));
  assert.equal(ui.activeOption.entry.title, titles[1]);
});

test('arrows cross group boundaries — the list walks as one', () => {
  const { ui } = setup();
  ui.open();
  ui.setQuery('read');

  const widgets = new Set();
  for (let i = 0; i < ui.options.length; i += 1) {
    widgets.add(ui.activeOption.entry.widgetId);
    ui.handleKeydown(key('ArrowDown'));
  }
  assert.ok(widgets.size > 1, 'arrowing reaches results from more than one widget');
});

test('arrows wrap at both ends rather than dead-ending', () => {
  const { ui } = setup();
  ui.open();
  ui.setQuery('read');
  const last = ui.options.length - 1;

  ui.handleKeydown(key('ArrowUp'));
  assert.equal(ui.activeIndex, last, 'up from the first wraps to the last');

  ui.handleKeydown(key('ArrowDown'));
  assert.equal(ui.activeIndex, 0, 'down from the last wraps to the first');
});

test('Home and End jump to the ends', () => {
  const { ui } = setup();
  ui.open();
  ui.setQuery('read');
  ui.handleKeydown(key('End'));
  assert.equal(ui.activeIndex, ui.options.length - 1);
  ui.handleKeydown(key('Home'));
  assert.equal(ui.activeIndex, 0);
});

test('arrowing with no results does not crash or select anything', () => {
  const { ui } = setup();
  ui.open();
  ui.setQuery('zzzznothing');
  ui.handleKeydown(key('ArrowDown'));
  assert.equal(ui.activeIndex, -1);
  assert.equal(ui.activeOption, null);
});

test('Escape closes and clears the query', () => {
  const { ui } = setup();
  ui.open();
  ui.setQuery('read');
  ui.handleKeydown(key('Escape'));
  assert.equal(ui.isOpen, false);
  assert.equal(ui.query, '');
  assert.equal(ui.input.value, '');
});

test('navigation keys are swallowed so the page does not scroll behind the palette', () => {
  const { ui } = setup();
  ui.open();
  ui.setQuery('read');
  for (const name of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape']) {
    const event = key(name);
    ui.handleKeydown(event);
    assert.equal(event.defaultPrevented, true, `${name} must be swallowed`);
    if (!ui.isOpen) ui.open();
    ui.setQuery('read');
  }
});

test('an ordinary letter is left alone for the input to handle', () => {
  const { ui } = setup();
  ui.open();
  const event = key('a');
  assert.equal(ui.handleKeydown(event), false);
  assert.equal(event.defaultPrevented, false);
});

test('typing in the input drives the query', () => {
  const { ui } = setup();
  ui.open();
  ui.input.value = 'reading';
  ui.input.dispatchEvent({ type: 'input' });
  assert.equal(ui.query, 'reading');
  assert.deepEqual(optionTitles(ui), ['Reading group']);
});

// ── Selecting: the deep-link seam ─────────────────────────────────────────

test('selecting an entry with no url jumps to its widget through the seam', () => {
  const { ui, navigated } = setup();
  ui.open();
  ui.setQuery('reading group');

  const result = ui.select();
  assert.equal(result.action, 'goto-widget');
  assert.deepEqual(
    navigated.map((n) => n.widgetId),
    ['calendar-1']
  );
});

test('selecting an entry with a url opens the url instead', () => {
  const { ui, opened, navigated } = setup();
  ui.open();
  ui.setQuery('notes');

  const result = ui.select();
  assert.equal(result.action, 'open-url');
  assert.deepEqual(
    opened.map((o) => o.url),
    ['https://notes.example.invalid/']
  );
  assert.deepEqual(navigated, [], 'a url entry does not also scroll the grid');
});

test('defaultActionFor is what decides between the two', () => {
  assert.equal(defaultActionFor({ url: 'https://x.example.invalid/' }), 'open-url');
  assert.equal(defaultActionFor({ title: 'An event' }), 'goto-widget');
  assert.equal(defaultActionFor(null), 'goto-widget');
});

test('with no navigate callback injected, the seam falls back to the #widget-id hash', () => {
  // The grid owns scroll-and-highlight and listens on the hash; this asserts
  // the default path sets exactly the deep link it is watching for.
  const index = new SearchIndex();
  index.setEntries('calendar-7', CALENDAR, { label: 'Calendar' });

  const document = createFakeDocument();
  const ui = new SearchUI(index, { documentRef: document });
  const container = new FakeElement('div');
  ui.mount(container);

  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const fakeLocation = { hash: '' };
  Object.defineProperty(globalThis, 'location', {
    value: fakeLocation,
    configurable: true,
    writable: true,
  });
  try {
    ui.open();
    ui.setQuery('reading group');
    ui.select();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'location', previous);
    else delete globalThis.location;
  }

  assert.equal(fakeLocation.hash, '#calendar-7');
});

test('Enter selects the highlighted result, not the first one', () => {
  const { ui, navigated, opened } = setup();
  ui.open();
  ui.setQuery('read');
  ui.handleKeydown(key('ArrowDown'));
  const expected = ui.activeOption.entry;

  ui.handleKeydown(key('Enter'));

  const landed = [...navigated, ...opened].length;
  assert.equal(landed, 1);
  const actual = navigated[0]?.entry ?? opened[0]?.entry;
  assert.equal(actual.id, expected.id);
});

test('selecting closes the palette so it is not covering what it jumped to', () => {
  const { ui } = setup();
  ui.open();
  ui.setQuery('reading group');
  ui.select();
  assert.equal(ui.isOpen, false);
});

test('Enter with no results does nothing', () => {
  const { ui, navigated, opened } = setup();
  ui.open();
  ui.setQuery('zzzznothing');
  assert.equal(ui.select(), null);
  assert.deepEqual([...navigated, ...opened], []);
  assert.equal(ui.isOpen, true, 'a dud Enter does not close the palette');
});

test('clicking a result does what Enter does', () => {
  const { ui, navigated } = setup();
  ui.open();
  ui.setQuery('reading group');

  const option = ui.root.querySelectorAll('[data-result-index]')[0];
  const listbox = ui.root.querySelector('.haven-search__results');
  listbox.dispatchEvent({ type: 'click', target: option });

  assert.deepEqual(
    navigated.map((n) => n.widgetId),
    ['calendar-1']
  );
});

// ── Empty and no-results states ───────────────────────────────────────────

test('the empty state names what is searchable', () => {
  const { ui } = setup();
  ui.open();
  const message = ui.root.querySelector('.haven-search__message');
  assert.match(message.textContent, /Apps/);
  assert.match(message.textContent, /Calendar/);
  assert.match(message.textContent, /Alerts/);
});

test('with nothing indexed the empty state says so usefully', () => {
  const { ui } = setup({ seed: false });
  ui.open();
  const message = ui.root.querySelector('.haven-search__message');
  assert.match(message.textContent, /add a widget/i);
});

test('the no-results state quotes the query and suggests something', () => {
  const { ui } = setup();
  ui.open();
  ui.setQuery('zzzznothing');
  const message = ui.root.querySelector('.haven-search__message');
  assert.match(message.textContent, /zzzznothing/);
  assert.match(message.textContent, /different word/i);
});

test('the result count is announced politely for a screen reader', () => {
  const { ui } = setup();
  ui.open();
  const status = ui.root.querySelector('.haven-search__status');
  assert.equal(status.getAttribute('aria-live'), 'polite');

  ui.setQuery('reading group');
  assert.match(status.textContent, /^1 result in 1 section$/);

  ui.setQuery('read');
  assert.match(status.textContent, /^\d+ results in \d+ sections$/);

  ui.setQuery('zzzznothing');
  assert.equal(status.textContent, 'No results');
});

// ── Staying in step with the index ────────────────────────────────────────

test('refresh re-queries after the index changed underneath the open palette', () => {
  const { ui, index } = setup();
  ui.open();
  ui.setQuery('reading group');
  assert.equal(ui.options.length, 1);

  // The calendar's 30s refresh drops the event.
  index.setEntries('calendar-1', [], { label: 'Calendar' });
  ui.refresh();

  assert.equal(ui.options.length, 0, 'a stale result must not linger on screen');
});

test('reopening starts from a clean query rather than the last search', () => {
  const { ui } = setup();
  ui.open();
  ui.setQuery('read');
  ui.close();
  ui.open();
  assert.equal(ui.query, '');
  assert.equal(ui.options.length, 0);
});

test('the UI renders result text as text, never as markup', () => {
  const index = new SearchIndex();
  index.setEntries('alerts-1', [{ id: 'a', title: '<img src=x onerror=alert(1)>' }], {
    label: 'Alerts',
  });
  const document = createFakeDocument();
  const ui = new SearchUI(index, { documentRef: document });
  ui.mount(new FakeElement('div'));
  ui.open();
  ui.setQuery('img');

  const title = ui.root.querySelector('.haven-search__option-title');
  // textContent round-trips the raw string — nothing was parsed as markup.
  assert.equal(title.textContent, '<img src=x onerror=alert(1)>');
});

test('SearchUI refuses to be built without an index', () => {
  assert.throws(() => new SearchUI(null), /SearchIndex/);
});
