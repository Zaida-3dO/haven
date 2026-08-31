import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  SECRET_SET_HINT,
  SECRET_UNSET_HINT,
  applyPatch,
  collectPatch,
  connectSettings,
  createSettingsPanel,
} from '../src/shell/settings-panel.js';
import { createCustomElements, createFakeDocument } from './helpers/fake-dom.js';
import { WidgetRegistry } from '../src/shell/registry.js';
import { Dashboard } from '../src/shell/dashboard.js';
import { Scheduler } from '../src/shell/scheduler.js';

/**
 * A widget exercising every field type at once, including the two things most
 * likely to be got wrong: a `secret`, and a field gated on another's value.
 *
 * Hostnames are `.invalid` on purpose — a fixture is a tracked file, and
 * docs/SECURITY.md draws no distinction between a fixture and production code.
 */
const FEED_SCHEMA = Object.freeze([
  {
    key: 'mode',
    type: 'select',
    label: 'Mode',
    default: 'public',
    options: [
      { value: 'public', label: 'Public' },
      { value: 'api', label: 'API' },
    ],
  },
  { key: 'title', type: 'text', label: 'Title', required: true },
  { key: 'endpoint', type: 'url', label: 'Endpoint' },
  { key: 'limit', type: 'number', label: 'Limit', min: 1, max: 50, default: 10 },
  // Only when mode is `api` — the asymmetry the contract calls out: the
  // descriptor names ITSELF with `key`, the clause names a SIBLING with `field`.
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API key',
    visible: { field: 'mode', operator: 'eq', value: 'api' },
  },
]);

const feedDefinition = Object.freeze({
  type: 'feed',
  name: 'Feed',
  tag: 'haven-feed',
  defaultSize: { w: 3, h: 2 },
  minSize: { w: 2, h: 1 },
  configSchema: FEED_SCHEMA,
  configVersion: 1,
});

function baseConfig(overrides = {}) {
  return {
    mode: 'public',
    title: 'Feed',
    endpoint: 'https://feed.invalid/rss',
    limit: 10,
    ...overrides,
  };
}

/** A panel over a fake document, plus a record of what `onSave` received. */
function mountPanel({ config = baseConfig(), definition = feedDefinition, onSave } = {}) {
  const doc = createFakeDocument();
  const saved = [];
  const errors = [];

  const panel = createSettingsPanel({
    document: doc,
    resolve: (id) => (id === 'w1' ? { definition, config, title: 'Feed' } : null),
    onSave:
      onSave ??
      ((id, next) => {
        saved.push({ id, config: next });
      }),
    onError: (err) => errors.push(err),
  });

  return { panel, doc, saved, errors };
}

/** Set an input's value the way a user typing into it would. */
function type(panel, key, value) {
  const input = panel.field(key);
  assert.ok(input, `expected a rendered field for "${key}"`);
  input.value = value;
  input.dispatchEvent({ type: 'input' });
  return input;
}

describe('collectPatch — the secret rule', () => {
  test('an untouched secret is OMITTED from the patch, not sent as an empty string', () => {
    // The single most important assertion in this file. `buildFormModel`
    // hands the form '' for a secret, so a naive collector would send '' back
    // and wipe a stored credential every time an unrelated option changed.
    const patch = collectPatch([
      { key: 'mode', type: 'select', raw: 'api' },
      { key: 'apiKey', type: 'secret', raw: '' },
    ]);

    assert.equal('apiKey' in patch, false, 'an empty secret must not appear in the patch at all');
    assert.deepEqual(patch, { mode: 'api' });

    // And layering it over the current config therefore PRESERVES the stored one.
    assert.equal({ ...{ mode: 'api', apiKey: 'stored-value' }, ...patch }.apiKey, 'stored-value');
  });

  test('a typed secret replaces the stored value', () => {
    const patch = collectPatch([{ key: 'apiKey', type: 'secret', raw: 'new' }]);
    assert.equal(patch.apiKey, 'new');
  });

  test('a field that is not rendered is absent from the patch, so its value survives', () => {
    // Rule 3 falls out of the patch shape: hidden fields are never rendered,
    // so they are never in `entries`, so `{...current, ...patch}` keeps them.
    const current = { mode: 'public', apiKey: 'kept', title: 'Feed' };
    const patch = collectPatch([
      { key: 'mode', type: 'select', raw: 'public' },
      { key: 'title', type: 'text', raw: 'Renamed' },
    ]);

    assert.equal('apiKey' in patch, false);
    assert.equal({ ...current, ...patch }.apiKey, 'kept');
  });
});

describe('applyPatch — one validator, not two', () => {
  test('reports issues from the schema validator, keyed by field', () => {
    const { issues, ok } = applyPatch(FEED_SCHEMA, baseConfig(), [
      { key: 'mode', type: 'select', raw: 'public' },
      { key: 'title', type: 'text', raw: '' },
      { key: 'endpoint', type: 'url', raw: 'not-a-url' },
      { key: 'limit', type: 'number', raw: '999' },
    ]);

    assert.equal(ok, false);
    const byKey = Object.fromEntries(issues.map((i) => [i.key, i.message]));
    assert.equal(byKey.title, 'is required');
    assert.equal(byKey.endpoint, 'must be a valid URL');
    assert.equal(byKey.limit, 'must be at most 50');
  });

  test('a number typed as a string is coerced by the schema, not by the form', () => {
    const { ok, value } = applyPatch(FEED_SCHEMA, baseConfig(), [
      { key: 'mode', type: 'select', raw: 'public' },
      { key: 'title', type: 'text', raw: 'Feed' },
      { key: 'endpoint', type: 'url', raw: 'https://feed.invalid/rss' },
      { key: 'limit', type: 'number', raw: '25' },
    ]);

    assert.equal(ok, true);
    assert.equal(value.limit, 25);
    assert.equal(typeof value.limit, 'number');
  });
});

describe('rendering a configSchema', () => {
  test('renders one control per visible field, in schema order', () => {
    const { panel } = mountPanel();
    panel.open('w1');

    assert.deepEqual(panel.fieldKeys, ['mode', 'title', 'endpoint', 'limit']);
    // `apiKey` is gated on mode === 'api', and mode is 'public'.
    assert.equal(panel.field('apiKey'), null);
  });

  test('maps each type to an input the browser understands', () => {
    const { panel } = mountPanel({ config: baseConfig({ mode: 'api' }) });
    panel.open('w1');

    assert.equal(panel.field('mode').tagName, 'SELECT');
    assert.equal(panel.field('title').getAttribute('type'), 'text');
    assert.equal(panel.field('endpoint').getAttribute('type'), 'url');
    assert.equal(panel.field('limit').getAttribute('type'), 'number');
    assert.equal(panel.field('apiKey').getAttribute('type'), 'password');
  });

  test('a number field carries its min and max, so the browser can help', () => {
    const { panel } = mountPanel();
    panel.open('w1');

    assert.equal(panel.field('limit').getAttribute('min'), '1');
    assert.equal(panel.field('limit').getAttribute('max'), '50');
  });

  test('a select is populated from the descriptor options and preselects the value', () => {
    const { panel } = mountPanel({ config: baseConfig({ mode: 'api' }) });
    panel.open('w1');

    const select = panel.field('mode');
    assert.deepEqual(
      select.children.map((o) => o.value),
      ['public', 'api']
    );
    assert.equal(select.value, 'api');
    assert.equal(select.children.find((o) => o.value === 'api').selected, true);
  });

  test('non-secret fields are prefilled from the stored config', () => {
    const { panel } = mountPanel();
    panel.open('w1');

    assert.equal(panel.field('title').value, 'Feed');
    assert.equal(panel.field('endpoint').value, 'https://feed.invalid/rss');
    assert.equal(panel.field('limit').value, '10');
  });
});

describe('a secret never reaches the browser', () => {
  test('the stored secret is NOT rendered into the input, even though it is in the config', () => {
    // The rule that matters most: a public dashboard must not put a
    // credential in the DOM. The config genuinely holds one here.
    const { panel } = mountPanel({
      config: baseConfig({ mode: 'api', apiKey: 'super-secret-token' }),
    });
    panel.open('w1');

    const input = panel.field('apiKey');
    assert.equal(input.value, '', 'the secret input must render empty');

    // And it is nowhere else in the panel's DOM either — not in a value, not
    // in an attribute, not in text. Serialise the whole subtree and look.
    assert.equal(
      serialise(panel.el).includes('super-secret-token'),
      false,
      'the stored secret must not appear anywhere in the rendered panel'
    );
  });

  test('the help text says whether a secret is set, without revealing it', () => {
    const withSecret = mountPanel({ config: baseConfig({ mode: 'api', apiKey: 'tok' }) });
    withSecret.panel.open('w1');
    assert.equal(serialise(withSecret.panel.el).includes(SECRET_SET_HINT), true);

    const without = mountPanel({ config: baseConfig({ mode: 'api' }) });
    without.panel.open('w1');
    assert.equal(serialise(without.panel.el).includes(SECRET_UNSET_HINT), true);
  });

  test('saving without touching the secret preserves the stored one', () => {
    const { panel, saved } = mountPanel({
      config: baseConfig({ mode: 'api', apiKey: 'stored-token' }),
    });
    panel.open('w1');

    type(panel, 'title', 'Renamed');
    panel.submit();

    assert.equal(saved.length, 1);
    assert.equal(saved[0].config.title, 'Renamed');
    assert.equal(saved[0].config.apiKey, 'stored-token', 'the untouched secret must survive');
  });

  test('typing a new secret replaces it', () => {
    const { panel, saved } = mountPanel({
      config: baseConfig({ mode: 'api', apiKey: 'stored-token' }),
    });
    panel.open('w1');

    type(panel, 'apiKey', 'replacement-token');
    panel.submit();

    assert.equal(saved[0].config.apiKey, 'replacement-token');
  });
});

describe('conditional visibility', () => {
  test('switching the gating field reveals the dependent one', () => {
    const { panel } = mountPanel();
    panel.open('w1');

    assert.equal(panel.field('apiKey'), null);
    type(panel, 'mode', 'api');
    assert.ok(panel.field('apiKey'), 'apiKey should appear once mode is api');
  });

  test('hiding a field again keeps its stored value through a save', () => {
    // "A hidden field keeps its value" — the host implements it and the form
    // must not undo it. Start in api mode with a key, switch to public, save.
    const { panel, saved } = mountPanel({
      config: baseConfig({ mode: 'api', apiKey: 'stored-token' }),
    });
    panel.open('w1');

    assert.ok(panel.field('apiKey'));
    type(panel, 'mode', 'public');
    assert.equal(panel.field('apiKey'), null, 'apiKey should be hidden in public mode');

    panel.submit();
    assert.equal(saved[0].config.mode, 'public');
    assert.equal(saved[0].config.apiKey, 'stored-token', 'the hidden value must be retained');
  });

  test('a hidden required field does not block saving', () => {
    // `validateConfig` only validates visible fields; the form must inherit
    // that rather than requiring something the user cannot even see.
    const schema = [
      { key: 'mode', type: 'select', options: ['off', 'on'], default: 'off' },
      {
        key: 'token',
        type: 'text',
        required: true,
        visible: { field: 'mode', operator: 'eq', value: 'on' },
      },
    ];
    const { panel, saved } = mountPanel({
      config: { mode: 'off' },
      definition: { ...feedDefinition, configSchema: schema },
    });
    panel.open('w1');

    panel.submit();
    assert.equal(saved.length, 1, 'a hidden required field must not block the save');
  });
});

describe('validation errors', () => {
  test('shows the error against the field that caused it', () => {
    const { panel, saved } = mountPanel();
    panel.open('w1');

    type(panel, 'endpoint', 'nonsense');
    panel.submit();

    const error = panel.errorFor('endpoint');
    assert.equal(error.hidden, false);
    assert.equal(error.textContent, 'must be a valid URL');
    assert.equal(panel.field('endpoint').getAttribute('aria-invalid'), 'true');

    // The unaffected field is not marked.
    assert.equal(panel.errorFor('title').hidden, true);
    assert.equal(panel.field('title').getAttribute('aria-invalid'), null);

    assert.equal(saved.length, 0, 'an invalid config must not be persisted');
    assert.equal(panel.isOpen, true, 'the panel stays open so the error can be fixed');
  });

  test('the error message comes from the schema validator verbatim', () => {
    // If this ever diverges, someone has written a second validator.
    const { panel } = mountPanel();
    panel.open('w1');

    type(panel, 'limit', '999');
    panel.submit();

    assert.equal(panel.errorFor('limit').textContent, 'must be at most 50');
  });

  test('moves focus to the first field that failed', () => {
    const { panel, doc } = mountPanel();
    panel.open('w1');

    type(panel, 'title', '');
    type(panel, 'endpoint', 'nonsense');
    panel.submit();

    assert.equal(doc.activeElement, panel.field('title'));
  });

  test('clears an error once it is fixed', () => {
    const { panel, saved } = mountPanel();
    panel.open('w1');

    type(panel, 'endpoint', 'nonsense');
    panel.submit();
    assert.equal(panel.errorFor('endpoint').hidden, false);

    type(panel, 'endpoint', 'https://other.invalid/feed');
    panel.submit();

    assert.equal(saved.length, 1);
    assert.equal(saved[0].config.endpoint, 'https://other.invalid/feed');
  });
});

describe('accessibility', () => {
  test('every label is tied to its input', () => {
    const { panel } = mountPanel({ config: baseConfig({ mode: 'api' }) });
    panel.open('w1');

    for (const key of panel.fieldKeys) {
      const input = panel.field(key);
      const wrap = findByFieldKey(panel.el, key);
      const label = wrap.children.find((c) => c.tagName === 'LABEL');
      assert.ok(label, `field "${key}" needs a label`);
      assert.equal(label.getAttribute('for'), input.id);
      assert.notEqual(input.id, '');
    }
  });

  test('an error is announced as part of its field, via aria-describedby', () => {
    const { panel } = mountPanel();
    panel.open('w1');

    const input = panel.field('endpoint');
    const describedBy = (input.getAttribute('aria-describedby') ?? '').split(' ');
    assert.ok(
      describedBy.includes(panel.errorFor('endpoint').id),
      'the error element must be referenced by the input it belongs to'
    );
  });

  test('the panel is a modal dialog with an accessible name', () => {
    const { panel } = mountPanel();
    panel.open('w1');

    assert.equal(panel.el.getAttribute('role'), 'dialog');
    assert.equal(panel.el.getAttribute('aria-modal'), 'true');
    const labelledBy = panel.el.getAttribute('aria-labelledby');
    const heading = panel.el.children.find((c) => c.id === labelledBy);
    assert.ok(heading, 'aria-labelledby must point at a real element');
    assert.equal(heading.textContent, 'Feed settings');
  });

  test('opening focuses the first control and closing hands focus back', () => {
    const { panel, doc } = mountPanel();

    const gear = doc.createElement('button');
    gear.focus();
    assert.equal(doc.activeElement, gear);

    panel.open('w1');
    assert.equal(doc.activeElement, panel.field('mode'), 'focus should land on the first control');

    panel.close();
    assert.equal(doc.activeElement, gear, 'focus must return to whatever opened the panel');
  });

  test('Tab from the last control wraps to the first — focus is trapped', () => {
    const { panel, doc } = mountPanel();
    panel.open('w1');

    const cancel = panel.el.querySelector('.haven-settings__cancel');
    cancel.focus();

    let prevented = false;
    panel.el.dispatchEvent({
      type: 'keydown',
      key: 'Tab',
      shiftKey: false,
      preventDefault: () => {
        prevented = true;
      },
    });

    assert.equal(prevented, true);
    assert.equal(doc.activeElement, panel.field('mode'));
  });

  test('Shift+Tab from the first control wraps to the last', () => {
    const { panel, doc } = mountPanel();
    panel.open('w1');

    panel.field('mode').focus();

    panel.el.dispatchEvent({
      type: 'keydown',
      key: 'Tab',
      shiftKey: true,
      preventDefault: () => {},
    });

    assert.equal(doc.activeElement, panel.el.querySelector('.haven-settings__cancel'));
  });

  test('Escape closes without saving', () => {
    const { panel, saved } = mountPanel();
    panel.open('w1');
    type(panel, 'title', 'Discarded');

    panel.el.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault: () => {} });

    assert.equal(panel.isOpen, false);
    assert.equal(saved.length, 0);
  });

  test('the error summary is an alert, so a rejected save is announced', () => {
    const { panel } = mountPanel();
    panel.open('w1');

    const summary = panel.el.querySelector('.haven-settings__summary');
    assert.equal(summary.getAttribute('role'), 'alert');
    assert.equal(summary.hidden, true);

    type(panel, 'endpoint', 'nonsense');
    panel.submit();

    assert.equal(summary.hidden, false);
    assert.equal(summary.textContent, '1 field needs attention.');
  });
});

describe('opening and closing', () => {
  test('open on an unknown widget does nothing', () => {
    const { panel } = mountPanel();
    assert.equal(panel.open('nope'), null);
    assert.equal(panel.isOpen, false);
    assert.equal(panel.el.hidden, true);
  });

  test('a save that throws keeps the panel open and reports the failure', async () => {
    const { panel, errors } = mountPanel({
      onSave: () => {
        throw new Error('the disk is on fire');
      },
    });
    panel.open('w1');

    await panel.submit();

    assert.equal(panel.isOpen, true);
    assert.equal(
      panel.el.querySelector('.haven-settings__summary').textContent,
      'the disk is on fire'
    );
    assert.equal(errors.length, 1);
  });
});

describe('connectSettings — persistence goes through the existing config path', () => {
  test('saving runs the widget migration hook', async () => {
    // The reason this does not write to the widget directly. A stored config
    // at v1 for a widget at v2 must be migrated on the way through, and
    // `host.setConfig` is the only thing that does that.
    const migrations = [];

    const doc = createFakeDocument();
    const customElements = createCustomElements();
    customElements.define('haven-migrating', class {});

    const definition = {
      type: 'migrating',
      name: 'Migrating',
      tag: 'haven-migrating',
      defaultSize: { w: 2, h: 2 },
      minSize: { w: 1, h: 1 },
      configSchema: [{ key: 'title', type: 'text', default: 'x' }],
      configVersion: 2,
      migrateConfig: (config, from) => {
        migrations.push(from);
        return { ...config, title: `${config.title}-migrated` };
      },
    };

    const registry = new WidgetRegistry();
    registry.register(definition);

    const { dashboard } = mountDashboard({ registry, doc, customElements });
    dashboard.add({ id: 'm1', type: 'migrating', config: { title: 'x', configVersion: 2 } });

    const panel = connectSettings({ dashboard, registry, document: doc });
    panel.open('m1');

    // Save a config stamped at the OLD version — the hook must run.
    panel.field('title').value = 'renamed';
    const host = dashboard.host('m1');
    host.setConfig({ title: 'renamed', configVersion: 1 });

    assert.deepEqual(migrations, [1], 'setConfig must run migrateConfig');
    assert.equal(host.config.title, 'renamed-migrated');
    assert.equal(host.config.configVersion, 2);
  });

  test('a save through the panel reaches the host and validates', async () => {
    const doc = createFakeDocument();
    const customElements = createCustomElements();
    customElements.define('haven-simple', class {});

    const definition = {
      type: 'simple',
      name: 'Simple',
      tag: 'haven-simple',
      defaultSize: { w: 2, h: 2 },
      minSize: { w: 1, h: 1 },
      configSchema: [
        { key: 'title', type: 'text', label: 'Title', required: true },
        { key: 'limit', type: 'number', label: 'Limit', min: 1, max: 5, default: 3 },
      ],
      configVersion: 1,
    };

    const registry = new WidgetRegistry();
    registry.register(definition);

    const { dashboard } = mountDashboard({ registry, doc, customElements });
    dashboard.add({ id: 's1', type: 'simple', config: { title: 'Before', limit: 3 } });

    const panel = connectSettings({ dashboard, registry, document: doc });
    panel.open('s1');

    panel.field('title').value = 'After';
    await panel.submit();

    assert.equal(dashboard.host('s1').config.title, 'After');
    assert.equal(panel.isOpen, false);
  });

  test('a save the host rejects keeps the panel open and surfaces the reason', async () => {
    // Belt and braces: the host's migrate + `parseConfig` is the real gate,
    // and the panel must respect a rejection there rather than closing as if
    // it had worked. Here the stored config is stamped from a NEWER build,
    // which migrate.js refuses to downgrade — so any save carrying that stamp
    // fails inside `setConfig`.
    const doc = createFakeDocument();
    const customElements = createCustomElements();
    customElements.define('haven-strict', class {});

    const definition = {
      type: 'strict',
      name: 'Strict',
      tag: 'haven-strict',
      defaultSize: { w: 2, h: 2 },
      minSize: { w: 1, h: 1 },
      configSchema: [{ key: 'title', type: 'text', label: 'Title', default: 'x' }],
      configVersion: 1,
    };

    const registry = new WidgetRegistry();
    registry.register(definition);

    const { dashboard } = mountDashboard({ registry, doc, customElements });
    dashboard.add({ id: 'x1', type: 'strict', config: { title: 'ok', configVersion: 99 } });

    const host = dashboard.host('x1');
    assert.ok(host.error, 'a future config version must fail');

    const panel = connectSettings({ dashboard, registry, document: doc });
    // Opens on the preserved bad config, which still carries `configVersion: 99`.
    panel.open('x1');
    panel.field('title').value = 'renamed';

    await panel.submit();

    assert.equal(panel.isOpen, true, 'the panel stays open when the host rejects the save');
    const summary = panel.el.querySelector('.haven-settings__summary');
    assert.equal(summary.hidden, false);
    assert.match(summary.textContent, /only understands version 1/);
  });

  test('opens on a widget whose config failed, using the preserved bad config', () => {
    // Lovelace's `origConfig`: a misconfigured widget must be openable and
    // fixable, not only deletable.
    const doc = createFakeDocument();
    const customElements = createCustomElements();
    customElements.define('haven-req', class {});

    const definition = {
      type: 'req',
      name: 'Req',
      tag: 'haven-req',
      defaultSize: { w: 2, h: 2 },
      minSize: { w: 1, h: 1 },
      configSchema: [{ key: 'endpoint', type: 'url', label: 'Endpoint', required: true }],
      configVersion: 1,
    };

    const registry = new WidgetRegistry();
    registry.register(definition);

    const { dashboard } = mountDashboard({ registry, doc, customElements });
    dashboard.add({ id: 'b1', type: 'req', config: { endpoint: 'not-a-url' } });

    const host = dashboard.host('b1');
    assert.ok(host.error, 'the fixture should be in the error state');

    const panel = connectSettings({ dashboard, registry, document: doc });
    assert.equal(panel.open('b1'), 'b1');
    assert.equal(panel.field('endpoint').value, 'not-a-url', 'the bad config must be shown to fix');
  });
});

/** A dashboard whose hosts render into fake elements. */
function mountDashboard({ registry, doc, customElements }) {
  const container = doc.createElement('div');
  const dashboard = new Dashboard({
    registry,
    container,
    scheduler: new Scheduler(),
  });
  // `WidgetHost` reads these off globals; the suite has no real DOM.
  globalThis.document = doc;
  globalThis.customElements = customElements;
  return { dashboard, container };
}

/** The `.haven-settings__field` wrapper for a key. */
function findByFieldKey(root, key) {
  for (const child of root.children ?? []) {
    if (child.dataset?.fieldKey === key && child.className?.includes('__field')) return child;
    const found = findByFieldKey(child, key);
    if (found) return found;
  }
  return null;
}

/** Flatten an element tree to a string: values, attributes and text. */
function serialise(node) {
  if (!node) return '';
  const parts = [node.className ?? '', node._textContent ?? '', String(node.value ?? '')];
  for (const [name, value] of node.attributes ?? []) parts.push(`${name}=${value}`);
  for (const child of node.children ?? []) parts.push(serialise(child));
  return parts.join(' ');
}
