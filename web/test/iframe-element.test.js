/**
 * The iframe widget element.
 *
 * The load-bearing test in this file is `the iframe element survives a data
 * tick` — re-creating the frame reloads the embedded document and destroys its
 * WebGL context. Everything else here is supporting.
 *
 * Same module-load dance as `hero-element.test.js`: the element resolves its
 * base class at import, so a minimal `HTMLElement` and `document` go in before
 * the import and come out after.
 */

import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { createFakeDocument, FakeElement } from './helpers/fake-dom.js';
import { doneData, errorData } from '../src/shell/panel-data.js';

const realDocument = globalThis.document;
const realHTMLElement = globalThis.HTMLElement;
const realLocation = globalThis.location;

globalThis.document = createFakeDocument();
globalThis.HTMLElement = class extends FakeElement {
  constructor() {
    super('haven-widget-iframe');
  }
};
/**
 * An embed's messages are addressed to the frame's own origin, resolved
 * against the page's — which means the widget needs a `location` to read.
 * Node has none, so one is installed here rather than making the code fall
 * back to `'*'`, which is the habit this widget deliberately avoids.
 */
globalThis.location = { origin: 'https://haven.invalid' };

const { HavenIframe } = await import('../src/widgets/iframe/element.js');
const { HOME_3D_URL } = await import('../src/widgets/iframe/definition.js');
const { EmbedUrlError } = await import('../src/widgets/iframe/embed-url.js');
const { RESIZE_MESSAGE_TYPE } = await import('../src/widgets/iframe/geometry.js');

after(() => {
  globalThis.document = realDocument;
  globalThis.HTMLElement = realHTMLElement;
  globalThis.location = realLocation;
});

// The real shipped default, imported rather than copied: a test that hardcodes
// its own URL keeps passing when the widget starts pointing somewhere else.
const CONFIG = {
  url: HOME_3D_URL,
  title: '3D home',
  scroll: 'no',
  allowForms: 'no',
  allowPopups: 'no',
  allowSameOrigin: 'no',
};

/**
 * A widget with its config set and made visible, which is the normal steady
 * state — lazy loading is tested separately.
 */
function makeEmbed({ config = CONFIG, visible = true } = {}) {
  const el = new HavenIframe();
  el.setConfig(config);
  if (visible) el.show();
  return el;
}

/** Gives a frame a `contentWindow` that records what was posted to it. */
function attachWindow(frame) {
  const posted = [];
  frame.contentWindow = {
    postMessage: (message, targetOrigin) => posted.push({ message, targetOrigin }),
  };
  frame.getBoundingClientRect = () => ({ width: 800, height: 600 });
  return posted;
}

test('renders a frame pointing at the configured URL', () => {
  const el = makeEmbed();
  const frame = el.frame;

  assert.ok(frame, 'expected a frame');
  assert.equal(frame.tagName, 'IFRAME');
  assert.equal(frame.getAttribute('src'), HOME_3D_URL);
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
});

test('setConfig throws on a javascript: URL', () => {
  // The host catches this and renders the fallback tile with the bad config
  // preserved — the contract's error path, exercised through the widget.
  const el = new HavenIframe();
  assert.throws(() => el.setConfig({ ...CONFIG, url: 'javascript:alert(1)' }), EmbedUrlError);
});

test('setConfig preserves the offending config so it can be fixed', () => {
  const el = new HavenIframe();
  const bad = { ...CONFIG, url: 'data:text/html,x' };
  assert.throws(() => el.setConfig(bad));
  assert.deepEqual(el.origConfig, bad);
});

// ── The invariant this whole widget exists to protect ────────────────────

test('the iframe element survives a data tick', () => {
  // Re-creating the frame reloads the embedded page: the WebGL context, the
  // loaded geometry and the camera position all go. `onData` must patch.
  const el = makeEmbed();
  const before = el.frame;
  const beforeSrc = before.getAttribute('src');

  el.onData(doneData({ anything: 1 }));
  el.onData(doneData({ anything: 2 }));

  assert.equal(el.frame, before, 'the iframe element was re-created on a data tick');
  assert.equal(el.frame.getAttribute('src'), beforeSrc);
});

test('a data tick does not rewrite src, which would reload the frame', () => {
  // Assigning `src` reloads the document even when the value is identical, so
  // identity alone is not enough — the attribute write must not happen either.
  const el = makeEmbed();
  const frame = el.frame;

  let writes = 0;
  const realSetAttribute = frame.setAttribute.bind(frame);
  frame.setAttribute = (name, value) => {
    if (name === 'src') writes += 1;
    return realSetAttribute(name, value);
  };

  el.onData(doneData({ tick: 1 }));
  el.onResize(8, 6);
  el.render();

  assert.equal(writes, 0, 'src was rewritten, which reloads the embedded page');
});

test('the iframe element survives a resize', () => {
  const el = makeEmbed();
  const before = el.frame;
  el.onResize(9, 7);
  assert.equal(el.frame, before, 'the iframe element was re-created on resize');
});

test('a changed URL does replace src — a new embed is a new page', () => {
  const el = makeEmbed();
  const frame = el.frame;

  el.setConfig({ ...CONFIG, url: 'https://other.invalid/page' });

  assert.equal(el.frame, frame, 'the element itself should still be reused');
  assert.equal(el.frame.getAttribute('src'), 'https://other.invalid/page');
});

// ── Geometry forwarding: the WebGL half ──────────────────────────────────

test('onResize forwards geometry into the frame', () => {
  const el = makeEmbed();
  const posted = attachWindow(el.frame);

  el.onResize(6, 4);

  assert.equal(posted.length, 1, 'expected exactly one message per resize');
  assert.equal(posted[0].message.type, RESIZE_MESSAGE_TYPE);
  assert.equal(posted[0].message.width, 800);
  assert.equal(posted[0].message.height, 600);
  assert.deepEqual(posted[0].message.cells, { w: 6, h: 4 });
  // Addressed to the embed's own origin. The default embed is now
  // cross-origin, so this is the 3D home's host rather than the dashboard's —
  // and never `'*'`, which is what the next test pins down.
  assert.equal(posted[0].targetOrigin, new URL(HOME_3D_URL).origin);
});

test('geometry is addressed to the embed origin, never to *', () => {
  const el = makeEmbed({ config: { ...CONFIG, url: 'https://scene.invalid/view' } });
  const posted = attachWindow(el.frame);

  el.onResize(6, 4);

  assert.equal(posted[0].targetOrigin, 'https://scene.invalid');
  assert.notEqual(posted[0].targetOrigin, '*');
});

// ── Lazy loading ─────────────────────────────────────────────────────────

test('no document is loaded until the widget is visible', () => {
  const el = makeEmbed({ visible: false });

  assert.equal(el.loaded, false);
  assert.equal(el.frame.getAttribute('src'), null, 'src was set before the widget was visible');
  assert.equal(el.frame.hidden, true);
});

test('becoming visible loads the frame', () => {
  const el = makeEmbed({ visible: false });
  el.show();

  assert.equal(el.loaded, true);
  assert.equal(el.frame.getAttribute('src'), HOME_3D_URL);
  assert.equal(el.frame.hidden, false);
});

// ── Sandbox surfacing ────────────────────────────────────────────────────

test('opting into same-origin access is visible on the tile', () => {
  const el = makeEmbed({ config: { ...CONFIG, allowSameOrigin: 'yes' } });

  assert.equal(el.frame.getAttribute('sandbox'), 'allow-same-origin allow-scripts');
  const warning = el.shadowRoot.querySelector('.embed__warning');
  assert.ok(warning);
  assert.equal(warning.hidden, false);
  assert.match(warning.textContent, /sandbox off/i);
});

test('the warning stays hidden with the default sandbox', () => {
  const el = makeEmbed();
  assert.equal(el.shadowRoot.querySelector('.embed__warning').hidden, true);
});

// ── Contract odds and ends ───────────────────────────────────────────────

test('an error payload renders the fallback with the config preserved', () => {
  const el = makeEmbed();
  el.onData(errorData(new Error('upstream is down')));

  const box = el.shadowRoot.querySelector('.embed__error');
  assert.ok(box, 'expected the fallback tile');
  assert.match(box.textContent, /upstream is down/);
  assert.match(box.textContent, /3dhome\.3dojoda\.com/);
});

test('the title is contributed to the search index', () => {
  const el = makeEmbed();
  el.id = 'embed-3d';
  const [entry] = el.getSearchEntries();

  assert.equal(entry.title, '3D home');
  assert.equal(entry.url, '#embed-3d');
});

test('the widget owns no timer, so destroy has nothing to clear', () => {
  const el = makeEmbed();
  el.destroy();
  assert.equal(el.frame, null);
});
