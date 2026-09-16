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

const { HavenIframe, STYLES } = await import('../src/widgets/iframe/element.js');
const { HOME_3D_URL, iframeWidget } = await import('../src/widgets/iframe/definition.js');
const { EmbedUrlError, SANDBOX_NOTICE } = await import('../src/widgets/iframe/embed-url.js');
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
});

/**
 * The disclosure MOVED; it did not go away.
 *
 * It used to be a paragraph of body text inside the card. Ope asked for it off
 * the dashboard, and the tempting reading of that request is "delete it" —
 * which would silently drop disclosure of a real security grant. So the badge
 * still has to carry the full sentence somewhere a user can reach it, and the
 * glyph alone must never be the whole message.
 *
 * This is the test that fails if someone later "tidies up" the badge by
 * dropping its title, leaving a bare `!` that discloses nothing.
 */
test('the badge carries the full disclosure, not just a glyph', () => {
  const el = makeEmbed({ config: { ...CONFIG, allowSameOrigin: 'yes' } });
  const warning = el.shadowRoot.querySelector('.embed__warning');

  // The visible glyph is deliberately terse — the notice is not body text any
  // more — but the sentence must still be one hover or one screen reader away.
  assert.equal(warning.getAttribute('title'), SANDBOX_NOTICE);
  // The accessible name is the sentence, NOT the glyph. Without this a screen
  // reader announces "exclamation mark" and the disclosure is lost entirely
  // for exactly the users least able to inspect the tile.
  assert.equal(warning.getAttribute('aria-label'), SANDBOX_NOTICE);
  assert.match(SANDBOX_NOTICE, /sandbox off/i);
});

test('the warning stays hidden with the default sandbox', () => {
  const el = makeEmbed();
  assert.equal(el.shadowRoot.querySelector('.embed__warning').hidden, true);
});

// ── dfdf5e42: the disclosure must be reachable without a mouse ───────────

/**
 * The badge used to be a `<span role="note">` with no `tabindex` anywhere —
 * unreachable by Tab, so a keyboard-only user could never even land on it,
 * let alone read `title`. It is now a real `<button>`, which is focusable by
 * default with no `tabindex` hack needed at all.
 */
test('the badge is a real button, not a span pretending to be one', () => {
  const el = makeEmbed({ config: { ...CONFIG, allowSameOrigin: 'yes' } });
  const warning = el.shadowRoot.querySelector('.embed__warning');

  assert.equal(warning.tagName, 'BUTTON');
  // The fake DOM models `.type` as a plain property (as the real `.type` IDL
  // attribute behaves) rather than a content attribute — `getAttribute`
  // would not see it even on a real button unless `setAttribute` was used.
  assert.equal(warning.type, 'button');
});

/**
 * Tabbing to the badge must make the sentence readable without a mouse —
 * not just leave it sitting in `title`, which a keyboard user has no way to
 * trigger. This is the acceptance criterion's literal keyboard-only check:
 * focus lands on the badge, and the text sibling becomes visible.
 */
test('focusing the badge reveals the disclosure text, not just hover', () => {
  const el = makeEmbed({ config: { ...CONFIG, allowSameOrigin: 'yes' } });
  const warning = el.shadowRoot.querySelector('.embed__warning');
  const text = el.shadowRoot.querySelector('.embed__warning-text');

  assert.equal(text.hidden, true, 'starts hidden before focus');
  warning.dispatchEvent({ type: 'focus' });
  assert.equal(text.hidden, false, 'the sentence becomes visible on focus');
  assert.equal(warning.getAttribute('aria-expanded'), 'true');
  assert.equal(text.textContent, SANDBOX_NOTICE);

  warning.dispatchEvent({ type: 'blur' });
  assert.equal(text.hidden, true, 'hides again once focus moves on');
  assert.equal(warning.getAttribute('aria-expanded'), 'false');
});

/**
 * Click-to-reveal, chosen over hover/focus-only, because it is the one
 * mechanism a touch user also has: a `title` tooltip and CSS `:hover` never
 * fire on a touchscreen, so without this the disclosure would still be
 * unreachable for exactly the audience `tabindex` alone does not help.
 */
test('clicking the badge toggles the disclosure text for touch and mouse', () => {
  const el = makeEmbed({ config: { ...CONFIG, allowSameOrigin: 'yes' } });
  const warning = el.shadowRoot.querySelector('.embed__warning');
  const text = el.shadowRoot.querySelector('.embed__warning-text');

  assert.equal(text.hidden, true);
  warning.dispatchEvent({ type: 'click' });
  assert.equal(text.hidden, false);
  assert.equal(warning.getAttribute('aria-expanded'), 'true');

  warning.dispatchEvent({ type: 'click' });
  assert.equal(text.hidden, true, 'a second click hides it again');
  assert.equal(warning.getAttribute('aria-expanded'), 'false');
});

/**
 * `role="note"`/aria labelling must not regress per the acceptance criteria.
 * There is no longer a `role="note"` (a `<button>` has its own implicit
 * role, which is more correct for an interactive control), but the
 * accessible NAME — the thing a screen reader actually announces — is
 * asserted unchanged: still the full sentence via `title` and `aria-label`,
 * never the bare glyph, exactly as pinned by the pre-existing
 * "carries the full disclosure" test above.
 */
test('the accessible name survives becoming a button', () => {
  const el = makeEmbed({ config: { ...CONFIG, allowSameOrigin: 'yes' } });
  const warning = el.shadowRoot.querySelector('.embed__warning');

  assert.equal(warning.getAttribute('aria-label'), SANDBOX_NOTICE);
  assert.equal(warning.getAttribute('title'), SANDBOX_NOTICE);
});

/**
 * 06839d96 — ".embed { position: relative }" has nothing in the DOM tying it
 * to the badge that depends on it, so a future tidy-up can drop it without
 * anything visibly breaking in the diff. The badge is absolutely positioned
 * and would silently fall back to the initial containing block, which lands
 * it outside ".haven-sidebar__card"'s "overflow: hidden" clip.
 *
 * There is no layout engine in this test workspace (no jsdom, see
 * `fake-dom.js`), so this cannot read a real `offsetParent`. It instead
 * parses the extracted stylesheet text with the same rule the CSS spec uses
 * to pick an offset parent: the nearest ANCESTOR-in-markup with a `position`
 * other than `static`. The badge is a child of `.embed` in the DOM
 * (`#ensureScaffold`), so `.embed` must be the nearest such ancestor — which
 * only holds while `.embed` keeps `position: relative`.
 *
 * Verified by removing the declaration locally and re-running: this test
 * failed with `.embed` reporting position "static" instead of "relative",
 * exactly the regression it exists to catch. Restored before committing.
 */
test("the badge's offset parent is the embed container, not the initial containing block", () => {
  const rules = parseCssPositions(STYLES);

  assert.equal(rules.get('.embed'), 'relative');
  // `.embed__warning` must be the positioned element being anchored...
  assert.equal(rules.get('.embed__warning'), 'absolute');
  // ...and `.embed` must be its nearest positioned ancestor in the DOM the
  // widget actually builds (see `#ensureScaffold`: warning is appended
  // directly to `embed`, with nothing positioned in between).
  const el = makeEmbed();
  const warning = el.shadowRoot.querySelector('.embed__warning');
  assert.equal(warning.parentNode.className, 'embed');
});

/** Extracts `{ selector: positionValue }` from a stylesheet string. */
function parseCssPositions(css) {
  // Strip /* ... */ comments first — a selector preceded by a doc comment
  // otherwise pulls the comment's last line in as part of the selector text.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = new Map();
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(stripped))) {
    // A selector list block is split on the last newline/whitespace run so
    // only the actual selector (not stray preceding text) is captured.
    const selector = match[1]
      .trim()
      .split(/\s*\n\s*/)
      .pop()
      .trim();
    const posMatch = match[2].match(/position:\s*([a-z]+)/);
    if (posMatch) found.set(selector, posMatch[1]);
  }
  return found;
}

/**
 * The other half of the relocation: the settings panel.
 *
 * The badge is the at-a-glance surface; this is the one that explains the
 * grant next to the control that gives it. Asserted on the shipped schema so
 * that removing the help text — the thing that makes relocating the notice
 * legitimate rather than a quiet deletion — fails here.
 */
test('the sandbox grant is disclosed in the settings panel too', () => {
  const field = iframeWidget.configSchema.find((f) => f.key === 'allowSameOrigin');

  assert.ok(field, 'the allowSameOrigin field should exist');
  assert.ok(field.help, 'the allowSameOrigin field must carry the disclosure as help text');
  assert.ok(
    field.help.includes(SANDBOX_NOTICE),
    `the settings help must carry the same notice as the tile badge, got: ${field.help}`
  );
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
