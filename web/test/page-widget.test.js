/**
 * The custom-page widget.
 *
 * Same module-load dance as the other element suites: the element resolves its
 * base class at import.
 */

import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { createFakeDocument, FakeElement } from './helpers/fake-dom.js';
import { doneData, errorData } from '../src/shell/panel-data.js';
import { PageRegistry } from '../src/pages/registry.js';

const realDocument = globalThis.document;
const realHTMLElement = globalThis.HTMLElement;

globalThis.document = createFakeDocument();
globalThis.HTMLElement = class extends FakeElement {
  constructor() {
    super('haven-widget-page');
  }
};

const { HavenPageWidget, PageWidgetError } = await import('../src/widgets/page/element.js');
const { MODES } = await import('../src/widgets/page/definition.js');

after(() => {
  globalThis.document = realDocument;
  globalThis.HTMLElement = realHTMLElement;
});

let renders = 0;
const LIBRARY = {
  id: 'library-analytics',
  title: 'Library Analytics',
  summary: 'Items and watch time.',
  keywords: ['library', 'stats'],
  render: (target, ctx) => {
    renders += 1;
    const p = (ctx.documentRef ?? globalThis.document).createElement('p');
    p.className = 'built-by-page';
    p.textContent = 'page content';
    target.replaceChildren(p);
  },
};

function makeWidget({ config = { pageId: 'library-analytics', mode: MODES.SUMMARY } } = {}) {
  const pages = new PageRegistry();
  pages.register(LIBRARY);
  const el = new HavenPageWidget({ pages });
  el.setConfig(config);
  return el;
}

test('summary mode shows the title and links to the page route', () => {
  const el = makeWidget();

  assert.equal(el.shadowRoot.querySelector('.page-tile__title').textContent, 'Library Analytics');
  assert.equal(
    el.shadowRoot.querySelector('.page-tile__summary').textContent,
    'Items and watch time.'
  );

  const link = el.shadowRoot.querySelector('.page-tile__link');
  // The route, so the tile opens the page rather than scrolling to itself.
  assert.equal(link.getAttribute('href'), '#/page/library-analytics');
  assert.equal(link.hidden, false);
  assert.equal(el.shadowRoot.querySelector('.page-tile__body').hidden, true);
});

test('full mode renders the page inline', () => {
  const el = makeWidget({ config: { pageId: 'library-analytics', mode: MODES.FULL } });

  const body = el.shadowRoot.querySelector('.page-tile__body');
  assert.equal(body.hidden, false);
  assert.equal(el.shadowRoot.querySelector('.built-by-page').textContent, 'page content');
  assert.equal(el.shadowRoot.querySelector('.page-tile__summary').hidden, true);
});

test('a page body is not rebuilt on a data tick', () => {
  // Same diff-and-patch rule the iframe widget exists to demonstrate, applied
  // to authored content: re-running a page's render discards any DOM state it
  // holds.
  const el = makeWidget({ config: { pageId: 'library-analytics', mode: MODES.FULL } });
  const before = renders;
  const node = el.shadowRoot.querySelector('.built-by-page');

  el.onData(doneData({ a: 1 }));
  el.onData(doneData({ a: 2 }));
  el.onResize(6, 4);

  assert.equal(renders, before, 'the page render function ran again on a data tick');
  assert.equal(el.shadowRoot.querySelector('.built-by-page'), node, 'the page DOM was rebuilt');
});

test('setConfig throws when the page is not registered', () => {
  // The schema can check pageId is a string; only this can check it exists.
  const pages = new PageRegistry();
  const el = new HavenPageWidget({ pages });

  assert.throws(() => el.setConfig({ pageId: 'gone', mode: MODES.SUMMARY }), PageWidgetError);
  // And the bad config is kept, so the tile can be repointed rather than only
  // deleted.
  assert.deepEqual(el.origConfig, { pageId: 'gone', mode: MODES.SUMMARY });
});

test('the page contributes its title to the search index', () => {
  // The widget declares no dataSource, so it never reaches Dashboard#push —
  // Dashboard#add indexes it instead, which is why this must work without any
  // data ever arriving.
  const el = makeWidget();
  const [entry] = el.getSearchEntries();

  assert.equal(entry.title, 'Library Analytics');
  assert.equal(entry.subtitle, 'Items and watch time.');
  assert.equal(entry.url, '#/page/library-analytics');
  assert.ok(entry.keywords.includes('library'));
});

test('an error payload renders the fallback with the config preserved', () => {
  const el = makeWidget();
  el.onData(errorData(new Error('page source is down')));

  const box = el.shadowRoot.querySelector('.page-tile__error');
  assert.ok(box);
  assert.match(box.textContent, /page source is down/);
  assert.match(box.textContent, /library-analytics/);
});

test('a page that throws renders the fallback rather than blanking the tile', () => {
  const pages = new PageRegistry();
  pages.register({
    id: 'broken',
    title: 'Broken',
    render: () => {
      throw new Error('page blew up');
    },
  });
  const el = new HavenPageWidget({ pages });
  el.setConfig({ pageId: 'broken', mode: MODES.FULL });

  const box = el.shadowRoot.querySelector('.page-tile__error');
  assert.ok(box, 'a throwing page must not blank the tile');
  assert.match(box.textContent, /page blew up/);
});
