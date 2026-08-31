import test from 'node:test';
import assert from 'node:assert/strict';

import { WidgetHost, HOST_STATE } from '../src/shell/host.js';
import { doneData } from '../src/shell/panel-data.js';
import { createFakeDocument, createCustomElements, FakeElement } from './helpers/fake-dom.js';

/** A widget double implementing the lifecycle contract. */
function makeWidget({ onRender, onSetConfig } = {}) {
  const calls = { setConfig: 0, onData: 0, render: 0, resize: 0, destroy: 0 };
  const el = new FakeElement('haven-widget-demo');
  el.setConfig = (config) => {
    calls.setConfig += 1;
    el.config = config;
    onSetConfig?.(config);
  };
  el.onData = (data) => {
    calls.onData += 1;
    el.data = data;
  };
  el.render = () => {
    calls.render += 1;
    onRender?.();
  };
  el.onResize = () => void (calls.resize += 1);
  el.destroy = () => void (calls.destroy += 1);
  el.getSearchEntries = () => [{ id: 'e1', title: 'Entry' }];
  el.calls = calls;
  return el;
}

function setup({ definition = {}, widgetFactory = () => makeWidget(), define = true } = {}) {
  const tag = definition.tag ?? 'haven-widget-demo';
  const customElements = createCustomElements();
  const factories = new Map([[tag, widgetFactory]]);
  const document = createFakeDocument(factories);
  if (define) customElements.define(tag, widgetFactory);

  const full = {
    type: 'demo',
    name: 'Demo',
    tag,
    configSchema: [],
    configVersion: 1,
    searchable: true,
    ...definition,
  };

  const container = new FakeElement('div');
  const errors = [];
  const host = new WidgetHost(full, {
    instanceId: 'demo-1',
    documentRef: document,
    customElementsRef: customElements,
    graceMs: 50,
    onError: (e) => errors.push(e),
  });

  return { host, container, customElements, errors, tag, document };
}

test('a widget renders inside its own shadow root', () => {
  const widget = makeWidget();
  const { host, container } = setup({ widgetFactory: () => widget });
  const root = host.mount(container, {});

  assert.equal(host.state, HOST_STATE.READY);
  // Shadow DOM per widget: broken markup cannot corrupt the host layout.
  assert.ok(root.shadowRoot, 'the tile has a shadow root');
  assert.equal(root.shadowRoot.children[0], widget, 'the widget lives inside the shadow root');
  assert.equal(root.children.length, 0, 'nothing leaks into the light DOM');
  assert.equal(root.id, 'demo-1', 'stable id per instance, for #widget-id links');
});

test('a widget throwing in render produces an error tile and leaves siblings alive', () => {
  const good = makeWidget();
  const bad = makeWidget({
    onRender: () => {
      throw new Error('render exploded');
    },
  });

  const a = setup({ widgetFactory: () => good });
  a.host.mount(a.container, {});

  const b = setup({ widgetFactory: () => bad });
  b.host.mount(b.container, {});

  // The throw must be caught, not propagated.
  assert.doesNotThrow(() => b.host.render());

  assert.equal(b.host.state, HOST_STATE.ERROR);
  const card = b.host.root.shadowRoot.querySelector('.haven-widget__error');
  assert.ok(card, 'a fallback tile was rendered');
  assert.match(card.textContent, /render exploded/);

  // The sibling is untouched — the dashboard did not blank.
  assert.equal(a.host.state, HOST_STATE.READY);
  a.host.render();
  assert.equal(a.host.state, HOST_STATE.READY);
  assert.ok(good.calls.render > 0, 'the healthy widget still renders');
});

test('bad config throws inside setConfig and the bad config is preserved on the card', () => {
  const schema = [{ key: 'url', type: 'url', required: true }];
  const { host, container } = setup({ definition: { configSchema: schema } });

  const bad = { url: 'not a url', configVersion: 1 };
  host.mount(container, bad);

  assert.equal(host.state, HOST_STATE.ERROR);
  const card = host.root.shadowRoot.querySelector('.haven-widget__error');
  assert.ok(card);
  // Lovelace's origConfig: the widget can be OPENED AND FIXED, not only deleted.
  assert.deepEqual(host.origConfig, bad);
  assert.deepEqual(card.origConfig, bad, 'the error card carries the bad config');
  assert.match(card.textContent, /url/, 'the card says which field is wrong');
});

test('a widget defined 500ms late never shows an error card', async () => {
  const widget = makeWidget();
  const tag = 'haven-widget-late';
  const customElements = createCustomElements();
  const document = createFakeDocument(new Map([[tag, () => widget]]));
  const container = new FakeElement('div');

  const host = new WidgetHost(
    { type: 'late', name: 'Late', tag, configSchema: [], configVersion: 1 },
    {
      instanceId: 'late-1',
      documentRef: document,
      customElementsRef: customElements,
      // The real grace is 2s; 800ms keeps the test quick while still being
      // comfortably longer than the 500ms registration it must tolerate.
      graceMs: 800,
    }
  );

  host.mount(container, {});

  // Nothing is defined yet — this must NOT be an error.
  assert.notEqual(host.state, HOST_STATE.ERROR, 'no error card during the grace period');
  assert.equal(host.root.shadowRoot.querySelector('.haven-widget__error'), null);

  await new Promise((r) => setTimeout(r, 500));
  assert.equal(
    host.root.shadowRoot.querySelector('.haven-widget__error'),
    null,
    'still no error at 500ms'
  );

  customElements.define(tag, () => widget);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(host.state, HOST_STATE.READY, 'the tile rebuilt once the definition landed');
  assert.equal(host.root.shadowRoot.children[0], widget);
});

test('a widget that never registers does show an error once the grace expires', async () => {
  const tag = 'haven-widget-never';
  const customElements = createCustomElements();
  const document = createFakeDocument(new Map());
  const container = new FakeElement('div');

  const host = new WidgetHost(
    { type: 'never', name: 'Never', tag, configSchema: [], configVersion: 1 },
    { instanceId: 'n-1', documentRef: document, customElementsRef: customElements, graceMs: 30 }
  );
  host.mount(container, {});
  assert.notEqual(host.state, HOST_STATE.ERROR);

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(host.state, HOST_STATE.ERROR, 'the grace period is a delay, not a free pass');
});

test('identical data does not re-render, changed data does', () => {
  const widget = makeWidget();
  const { host, container } = setup({ widgetFactory: () => widget });
  host.mount(container, {});

  const before = widget.calls.onData;
  const first = doneData({ v: 1 });
  host.onData(first);
  assert.equal(widget.calls.onData, before + 1);

  // Same value → same revision → the widget must not be asked to redraw.
  // This is what stops a data tick blowing away a canvas.
  const same = doneData({ v: 1 }, { previous: first });
  host.onData(same);
  assert.equal(widget.calls.onData, before + 1, 'unchanged data did not reach the widget again');

  const changed = doneData({ v: 2 }, { previous: same });
  host.onData(changed);
  assert.equal(widget.calls.onData, before + 2, 'changed data did');
});

test('a widget throwing in getSearchEntries yields none rather than breaking search', () => {
  const widget = makeWidget();
  widget.getSearchEntries = () => {
    throw new Error('index exploded');
  };
  const { host, container } = setup({ widgetFactory: () => widget });
  host.mount(container, {});

  assert.deepEqual(host.getSearchEntries(), []);
});

test('search entries are tagged with the widget instance', () => {
  const { host, container } = setup();
  host.mount(container, {});
  const entries = host.getSearchEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].widgetId, 'demo-1');
});

test('destroy tears the tile down even if the widget throws', () => {
  const widget = makeWidget();
  widget.destroy = () => {
    throw new Error('bad cleanup');
  };
  const { host, container } = setup({ widgetFactory: () => widget });
  host.mount(container, {});

  assert.doesNotThrow(() => host.destroy());
  assert.equal(container.children.length, 0, 'the tile was removed from the container');
});
