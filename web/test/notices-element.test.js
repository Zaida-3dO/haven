import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeElement, createFakeDocument } from './helpers/fake-dom.js';

/**
 * `element.js` resolves its base class AT IMPORT TIME — `globalThis.HTMLElement`
 * in a browser, a bare stub under `node --test`. The stub has no
 * `attachShadow`, so the base has to be installed BEFORE the module is
 * imported, which is why this is a dynamic import rather than a static one.
 *
 * `FakeElement` already implements `attachShadow`, `replaceChildren`,
 * listeners and `querySelectorAll`, so the widget runs against the same DOM
 * double the rest of the web suite uses. No jsdom, per CLAUDE.md.
 */
class FakeCustomElement extends FakeElement {
  // A custom element is constructed by the browser with no arguments, so the
  // tag name has to come from the class rather than the call site.
  constructor() {
    super('haven-widget-notices');
  }
}
globalThis.HTMLElement = FakeCustomElement;

const { HavenNoticesWidget } = await import('../src/widgets/notices/element.js');

/**
 * The element, driven against the shared fake DOM — no jsdom, per CLAUDE.md.
 *
 * What these assert is the behaviour the brief actually names: severity is not
 * carried by colour alone, `due` orders the list, actions call back through
 * the backend, the empty state reads as good news, and nothing here persists
 * anything.
 *
 * Every fixture is invented and uses `.invalid` hostnames — a notice is
 * personal data and none of it belongs in a public repo.
 */

/**
 * Offsets are measured from the REAL clock, not a fixed instant.
 *
 * The element renders due times through `relativeDue`, which the widget calls
 * with the live `Date.now()` — it has no clock to inject, because the host
 * owns every timer. A frozen fixture date would therefore drift further from
 * "in 2 days" with every day that passes, so the fixtures are anchored to now
 * and the *pure* time formatting is pinned properly in notices-format.test.js.
 */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (offset) => new Date(Date.now() + offset).toISOString();

const notice = (overrides = {}) => ({
  id: 'chores:bin-day',
  severity: 'warn',
  title: 'Recycling goes out tonight',
  body: null,
  due: null,
  source: 'chores',
  url: null,
  actions: [],
  ...overrides,
});

/** A widget mounted on the fake DOM, with a recording transport. */
function widget({ notices = [], status = 'ok', extra = {}, respond = null } = {}) {
  const previousDocument = globalThis.document;
  globalThis.document = createFakeDocument();

  const posts = [];

  const element = new HavenNoticesWidget();
  element.fetchImpl = async (url, options) => {
    posts.push({ url, method: options?.method });
    if (respond) return respond(url);
    return { ok: true, status: 200, json: async () => ({ status: 'ok', dismissed: true }) };
  };

  element.setConfig({ maxItems: 20, minSeverity: 'info', showSource: false });
  element.onData({ state: 'done', value: { status, notices, ...extra }, revision: 1 });

  return {
    element,
    posts,
    shadow: element.shadowRoot,
    restore: () => {
      globalThis.document = previousDocument;
    },
  };
}

/** Depth-first text of every node with a class. */
function textOf(node, className) {
  return node.querySelectorAll(`.${className}`).map((n) => n.textContent);
}

function findAll(node, className) {
  return node.querySelectorAll(`.${className}`);
}

// ── Severity presentation ─────────────────────────────────────────────────

test('every notice shows a severity icon AND a word, not just a colour', (t) => {
  const w = widget({
    notices: [
      notice({ id: 'a', severity: 'info' }),
      notice({ id: 'b', severity: 'warn' }),
      notice({ id: 'c', severity: 'urgent' }),
    ],
  });
  t.after(w.restore);

  const icons = findAll(w.shadow, 'badge__icon');
  const labels = findAll(w.shadow, 'badge__label');

  // Three notices, three icons, three words. If a future change carries
  // severity in the colour alone, these counts drop.
  assert.equal(icons.length, 3);
  assert.equal(labels.length, 3);
  for (const icon of icons) assert.notEqual(icon.textContent.trim(), '');
  for (const label of labels) assert.notEqual(label.textContent.trim(), '');
});

test('the severity word is on an accessible label too, since it hides when narrow', (t) => {
  const w = widget({ notices: [notice({ severity: 'urgent' })] });
  t.after(w.restore);

  const [badge] = findAll(w.shadow, 'badge');
  assert.match(badge.getAttribute('aria-label'), /Urgent/);
});

test('severity drives the notice class, so presentation differs per level', (t) => {
  const w = widget({
    notices: [notice({ id: 'a', severity: 'info' }), notice({ id: 'b', severity: 'urgent' })],
  });
  t.after(w.restore);

  const classes = findAll(w.shadow, 'notice').map((n) => n.className);
  assert.ok(classes.some((c) => c.includes('notice--info')));
  assert.ok(classes.some((c) => c.includes('notice--urgent')));
});

// ── Ordering and due times ────────────────────────────────────────────────

test('notices render soonest-due first', (t) => {
  const w = widget({
    notices: [
      notice({ id: 'c', title: 'Later', due: at(5 * DAY) }),
      notice({ id: 'a', title: 'Sooner', due: at(HOUR) }),
    ],
  });
  t.after(w.restore);

  assert.deepEqual(textOf(w.shadow, 'notice__title'), ['Sooner', 'Later']);
});

test('a due time renders relative, with the absolute time on hover', (t) => {
  // A hair over two days, so Math.round cannot land it on 1 or 3.
  const w = widget({ notices: [notice({ due: at(2 * DAY + HOUR) })] });
  t.after(w.restore);

  const [due] = findAll(w.shadow, 'notice__due');
  assert.match(due.textContent, /in 2 days/);
  // The absolute form is what you need when planning, so it is the tooltip.
  assert.match(due.getAttribute('title'), /September/);
});

test('an overdue notice says so rather than only reading "2 days ago"', (t) => {
  const w = widget({ notices: [notice({ due: at(-2 * DAY) })] });
  t.after(w.restore);

  const [due] = findAll(w.shadow, 'notice__due');
  assert.match(due.textContent, /overdue/);
});

test('a notice with no due date renders without a due line', (t) => {
  const w = widget({ notices: [notice({ due: null })] });
  t.after(w.restore);

  assert.equal(findAll(w.shadow, 'notice__due').length, 0);
});

// ── The empty state ───────────────────────────────────────────────────────

test('an empty list reads as good news, not as an error', (t) => {
  const w = widget({ notices: [] });
  t.after(w.restore);

  const [title] = findAll(w.shadow, 'empty__title');
  assert.match(title.textContent, /Nothing needs you/);

  // The failure and error classes must be absent — this is a success state.
  assert.equal(findAll(w.shadow, 'failure').length, 0);
});

test('the empty state admits when a filter is doing the hiding', (t) => {
  // Otherwise "nothing needs you" is a lie the user configured and forgot.
  const previousDocument = globalThis.document;
  globalThis.document = createFakeDocument();
  t.after(() => {
    globalThis.document = previousDocument;
  });

  const element = new HavenNoticesWidget();
  element.setConfig({ minSeverity: 'urgent', maxItems: 10 });
  element.onData({
    state: 'done',
    value: { status: 'ok', notices: [notice({ severity: 'info' })] },
    revision: 1,
  });

  const [body] = findAll(element.shadowRoot, 'empty__body');
  assert.match(body.textContent, /hidden by this widget's filter/);
});

// ── Not configured ────────────────────────────────────────────────────────

test('a not_configured payload renders a hint, not an error', (t) => {
  const w = widget({
    status: 'not_configured',
    extra: { hint: 'Set HAVEN_HA_TOKEN to enable Home Assistant notices.' },
  });
  t.after(w.restore);

  const [title] = findAll(w.shadow, 'hint__title');
  assert.match(title.textContent, /not configured/);
  const [body] = findAll(w.shadow, 'hint__body');
  assert.match(body.textContent, /HAVEN_HA_TOKEN/);
});

// ── A soft notice ─────────────────────────────────────────────────────────

test('a stale marker draws alongside the data, not instead of it', (t) => {
  const w = widget({
    notices: [notice()],
    extra: { notice: 'Showing the last reading — Home Assistant is unreachable.' },
  });
  t.after(w.restore);

  // A soft notice is not a hard error: the list still draws, with a marker.
  assert.equal(findAll(w.shadow, 'notice').length, 1);
  assert.match(findAll(w.shadow, 'notice-bar')[0].textContent, /unreachable/);
});

// ── Actions ───────────────────────────────────────────────────────────────

test('actions render as buttons carrying only an opaque id', (t) => {
  const w = widget({
    notices: [notice({ actions: [{ id: 'ha-dismiss', label: 'Dismiss in HA', dismisses: true }] })],
  });
  t.after(w.restore);

  const [button] = findAll(w.shadow, 'notice__action');
  assert.equal(button.textContent, 'Dismiss in HA');
  assert.equal(button.dataset.actionId, 'ha-dismiss');
});

test('pressing an action POSTs THROUGH THE BACKEND, never to a service', async (t) => {
  const w = widget({
    notices: [notice({ actions: [{ id: 'lock', label: 'Lock it', dismisses: true }] })],
  });
  t.after(w.restore);

  const [button] = findAll(w.shadow, 'notice__action');
  await button.listeners.get('click')[0]();

  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].method, 'POST');
  // The backend resolves what the action means; the browser knows only the id.
  assert.equal(w.posts[0].url, '/api/widgets/notices/chores%3Abin-day/actions/lock');
});

test('an action that dismisses removes the notice from the tile', async (t) => {
  const w = widget({
    notices: [notice({ actions: [{ id: 'done', label: 'Done', dismisses: true }] })],
  });
  t.after(w.restore);

  const [button] = findAll(w.shadow, 'notice__action');
  await button.listeners.get('click')[0]();

  assert.equal(findAll(w.shadow, 'notice').length, 0);
});

test('a failed action says so and does NOT claim the notice was handled', async (t) => {
  const w = widget({
    notices: [notice({ actions: [{ id: 'lock', label: 'Lock it', dismisses: true }] })],
    respond: async () => ({
      ok: false,
      status: 502,
      json: async () => ({ message: 'The service did not respond.' }),
    }),
  });
  t.after(w.restore);

  const [button] = findAll(w.shadow, 'notice__action');
  await button.listeners.get('click')[0]();

  // The notice must still be there — telling the user a lock was locked when
  // it was not is the worst thing this widget could do.
  assert.equal(findAll(w.shadow, 'notice').length, 1);
  assert.match(findAll(w.shadow, 'failure')[0].textContent, /did not work/);
});

// ── Dismissal ─────────────────────────────────────────────────────────────

test('dismissing POSTs to the dismiss endpoint and hides the notice', async (t) => {
  const w = widget({ notices: [notice()] });
  t.after(w.restore);

  const [button] = findAll(w.shadow, 'notice__dismiss');
  await button.listeners.get('click')[0]();

  assert.equal(w.posts[0].url, '/api/widgets/notices/chores%3Abin-day/dismiss');
  assert.equal(findAll(w.shadow, 'notice').length, 0);
});

test('a failed dismissal brings the notice back rather than lying', async (t) => {
  const w = widget({
    notices: [notice()],
    respond: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  t.after(w.restore);

  const [button] = findAll(w.shadow, 'notice__dismiss');
  await button.listeners.get('click')[0]();

  // Optimistic is only honest if it un-does itself when the write fails.
  assert.equal(findAll(w.shadow, 'notice').length, 1);
  assert.match(findAll(w.shadow, 'failure')[0].textContent, /Could not dismiss/);
});

test('the dismiss button names the notice, so it is usable by a screen reader', (t) => {
  const w = widget({ notices: [notice({ title: 'Boiler service due' })] });
  t.after(w.restore);

  const [button] = findAll(w.shadow, 'notice__dismiss');
  assert.match(button.getAttribute('aria-label'), /Boiler service due/);
});

test('a dismissal the server has accepted stops being tracked locally', (t) => {
  const w = widget({ notices: [notice()] });
  t.after(w.restore);

  // The next poll no longer carries it, so the local set must let it go —
  // otherwise a genuinely new notice reusing the id would be invisible.
  w.element.onData({ state: 'done', value: { status: 'ok', notices: [] }, revision: 2 });
  w.element.onData({ state: 'done', value: { status: 'ok', notices: [notice()] }, revision: 3 });

  assert.equal(findAll(w.element.shadowRoot, 'notice').length, 1);
});

// ── Config ────────────────────────────────────────────────────────────────

test('setConfig THROWS on an unusable maxItems, as the contract requires', (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = createFakeDocument();
  t.after(() => {
    globalThis.document = previousDocument;
  });

  const element = new HavenNoticesWidget();

  // Throwing is what lets the host render an error card instead of a widget
  // that silently shows nothing.
  assert.throws(() => element.setConfig({ maxItems: 0 }), /positive number/);
  assert.throws(() => element.setConfig({ maxItems: -3 }), /positive number/);
  assert.throws(() => element.setConfig({ maxItems: 'lots' }), /positive number/);
});

test('the bad config is preserved so the error card can show it', (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = createFakeDocument();
  t.after(() => {
    globalThis.document = previousDocument;
  });

  const element = new HavenNoticesWidget();
  try {
    element.setConfig({ maxItems: 0, minSeverity: 'warn' });
  } catch {
    /* expected */
  }

  // A misconfigured widget should be openable and fixable, not only deletable.
  assert.deepEqual(element.origConfig, { maxItems: 0, minSeverity: 'warn' });
});

test('showSource renders the source only when asked', (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = createFakeDocument();
  t.after(() => {
    globalThis.document = previousDocument;
  });

  const off = new HavenNoticesWidget();
  off.setConfig({ showSource: false, maxItems: 10 });
  off.onData({ state: 'done', value: { status: 'ok', notices: [notice()] }, revision: 1 });
  assert.equal(findAll(off.shadowRoot, 'notice__source').length, 0);

  const on = new HavenNoticesWidget();
  on.setConfig({ showSource: true, maxItems: 10 });
  on.onData({ state: 'done', value: { status: 'ok', notices: [notice()] }, revision: 1 });
  assert.equal(findAll(on.shadowRoot, 'notice__source')[0].textContent, 'chores');
});

// ── Search ────────────────────────────────────────────────────────────────

test('each notice contributes one search entry', (t) => {
  const w = widget({
    notices: [notice({ id: 'a', title: 'First' }), notice({ id: 'b', title: 'Second' })],
  });
  t.after(w.restore);

  const entries = w.element.getSearchEntries();
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.title),
    ['First', 'Second']
  );
});

test('a search entry carries the keywords you would actually type', (t) => {
  const w = widget({ notices: [notice({ severity: 'urgent', due: at(2 * DAY) })] });
  t.after(w.restore);

  const [entry] = w.element.getSearchEntries();
  assert.ok(entry.keywords.includes('urgent'));
  assert.ok(entry.keywords.includes('chores'));
});

test('a dismissed notice is not searchable', (t) => {
  const w = widget({ notices: [notice()] });
  t.after(w.restore);

  const [button] = findAll(w.shadow, 'notice__dismiss');
  button.listeners.get('click')[0]();

  assert.deepEqual(w.element.getSearchEntries(), []);
});

test('getSearchEntries persists nothing — the index is in-memory only', (t) => {
  // Notice contents are the most personal data on the dashboard. The shell's
  // index has its own tripwire; this is the widget's half of that promise.
  const previousDocument = globalThis.document;
  const touched = [];
  const spy = (name) => ({
    setItem: () => touched.push(name),
    getItem: () => touched.push(name),
  });

  globalThis.document = createFakeDocument();
  const previousLocal = globalThis.localStorage;
  const previousSession = globalThis.sessionStorage;
  globalThis.localStorage = spy('localStorage');
  globalThis.sessionStorage = spy('sessionStorage');

  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.localStorage = previousLocal;
    globalThis.sessionStorage = previousSession;
  });

  const element = new HavenNoticesWidget();
  element.setConfig({ maxItems: 10 });
  element.onData({ state: 'done', value: { status: 'ok', notices: [notice()] }, revision: 1 });
  element.getSearchEntries();

  assert.deepEqual(touched, [], 'the widget touched a persistent store');
});

// ── Lifecycle ─────────────────────────────────────────────────────────────

test('the widget owns no timer, so destroy has none to clear', (t) => {
  const w = widget({ notices: [notice()] });
  t.after(w.restore);

  w.element.destroy();

  assert.equal(w.element.shadowRoot.children.length, 0);
  assert.deepEqual(w.element.getSearchEntries(), []);
});

test('a title is rendered as text, never as markup', (t) => {
  const w = widget({
    notices: [notice({ title: '<img src=x onerror=alert(1)>' })],
  });
  t.after(w.restore);

  // A notice title is arbitrary text from a source. It reaches the DOM only
  // through textContent, so it can never be parsed as markup.
  const [title] = findAll(w.shadow, 'notice__title');
  assert.equal(title.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(title.children.length, 0);
});

test('a notice url renders as a link with the right rel', (t) => {
  const w = widget({ notices: [notice({ url: 'https://chores.invalid/bin-day' })] });
  t.after(w.restore);

  const [link] = findAll(w.shadow, 'notice__link');
  assert.equal(link.getAttribute('href'), 'https://chores.invalid/bin-day');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
});
