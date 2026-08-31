/**
 * The load path, end to end: roster → host → widget.
 *
 * `instances-client.test.js` covers the client and the reconciler as units.
 * This file covers the thing that is easy to lose and impossible to retrofit:
 * that a config coming from `/api/instances` is still fed through
 * `migrateConfig` and then `parseConfig` before a widget sees it.
 *
 * A unit test of `migrateConfig` cannot prove that. It proves the function
 * works, not that anything still CALLS it — someone persisting the roster could
 * hand a stored config straight to a widget and every migrate.test.js
 * assertion would stay green. So these drive `Dashboard.add`, which is the
 * actual boot path (`grid.load` → `place` → `dashboard.add`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Dashboard } from '../src/shell/dashboard.js';
import { WidgetRegistry } from '../src/shell/registry.js';
import { createFakeDocument, createCustomElements, FakeElement } from './helpers/fake-dom.js';
import { SECRET_SET } from '../src/shell/instances-client.js';
import { reconcileRoster } from '../src/shell/roster.js';

/** A widget double that records every config it is handed. */
function widgetFactory(seen) {
  return () => {
    const el = new FakeElement('haven-widget-demo');
    el.setConfig = (config) => {
      seen.push(config);
      el.config = config;
    };
    el.onData = () => {};
    el.render = () => {};
    el.onResize = () => {};
    el.destroy = () => {};
    return el;
  };
}

/**
 * The dashboard builds hosts against the GLOBAL document, so — like
 * `dashboard.test.js` — the fake DOM is installed globally for the duration of
 * the body and restored afterwards.
 */
function withDashboard({ definition = {} } = {}, run) {
  const seen = [];
  const factory = widgetFactory(seen);
  const customElements = createCustomElements();
  const document = createFakeDocument(new Map([['haven-widget-demo', factory]]));
  customElements.define('haven-widget-demo', factory);

  const registry = new WidgetRegistry();
  registry.register({
    type: 'demo',
    name: 'Demo',
    tag: 'haven-widget-demo',
    configSchema: [],
    configVersion: 1,
    ...definition,
  });

  const prevDoc = globalThis.document;
  const prevCe = globalThis.customElements;
  globalThis.document = document;
  globalThis.customElements = customElements;

  try {
    const dashboard = new Dashboard({ registry, container: new FakeElement('div') });
    return run({ dashboard, registry, seen });
  } finally {
    globalThis.document = prevDoc;
    globalThis.customElements = prevCe;
  }
}

test('a config from the API is migrated before the widget sees it', () => {
  let hookCalls = 0;

  withDashboard(
    {
      definition: {
        configVersion: 2,
        migrateConfig: (config, from) => {
          hookCalls += 1;
          assert.equal(from, 1, 'the hook is told which version it is migrating from');
          return { ...config, label: `${config.label} (migrated)` };
        },
      },
    },
    ({ dashboard, seen }) => {
      // Exactly what `GET /api/instances` returns for a widget saved by an
      // older build: a v1 config against a widget that is now on v2.
      dashboard.add({ id: 'demo-1', type: 'demo', config: { label: 'Old', configVersion: 1 } });

      assert.equal(hookCalls, 1, 'migrateConfig was not called on the load path');
      assert.equal(seen.length, 1);
      assert.equal(seen[0].label, 'Old (migrated)');
      assert.equal(seen[0].configVersion, 2, 'the widget was handed a stale version stamp');
    }
  );
});

test('a widget whose config needs migrating but ships no hook errors rather than rendering', () => {
  withDashboard({ definition: { configVersion: 3 } }, ({ dashboard, seen }) => {
    const host = dashboard.add({
      id: 'demo-1',
      type: 'demo',
      config: { label: 'Old', configVersion: 1 },
    });

    // The error tile, not a widget handed a shape it has never seen.
    assert.equal(host.state, 'error');
    assert.equal(seen.length, 0);
    // The bad config is preserved so the settings form can open on it.
    assert.equal(host.origConfig.label, 'Old');
  });
});

test('a config from a NEWER build is refused rather than downgraded', () => {
  withDashboard({ definition: { configVersion: 1 } }, ({ dashboard, seen }) => {
    const host = dashboard.add({
      id: 'demo-1',
      type: 'demo',
      config: { label: 'From the future', configVersion: 9 },
    });

    assert.equal(host.state, 'error');
    assert.equal(seen.length, 0);
  });
});

test('re-saving a config runs it through the migration path again', () => {
  let hookCalls = 0;

  withDashboard(
    {
      definition: {
        configVersion: 2,
        migrateConfig: (config) => {
          hookCalls += 1;
          return { ...config, migratedBy: 'hook' };
        },
      },
    },
    ({ dashboard, seen }) => {
      const host = dashboard.add({ id: 'demo-1', type: 'demo', config: { configVersion: 2 } });
      assert.equal(hookCalls, 0, 'an already-current config needs no migration');

      // What the settings panel's `onSave` does. It matters that this too goes
      // through `setConfig`: persisting from anywhere that bypassed it would
      // write a config the hook never saw.
      host.setConfig({ label: 'Edited', configVersion: 1 });

      assert.equal(hookCalls, 1);
      assert.equal(seen.at(-1).migratedBy, 'hook');
      assert.equal(seen.at(-1).configVersion, 2);
    }
  );
});

test('the config a save would persist is the post-migration one', () => {
  withDashboard(
    {
      definition: {
        configVersion: 2,
        migrateConfig: (config) => ({ ...config, upgraded: true }),
      },
    },
    ({ dashboard }) => {
      const host = dashboard.add({
        id: 'demo-1',
        type: 'demo',
        config: { label: 'Old', configVersion: 1 },
      });

      // `boot.js` persists `host.config` / the config `connectSettings.onSave`
      // produced — both are the migrated one. Storing the PRE-migration config
      // would mean a dashboard that migrates on every single load and never
      // records the result, which is the silent version of losing the hook.
      assert.equal(host.config.upgraded, true);
      assert.equal(host.config.configVersion, 2);
    }
  );
});

test('a secret sentinel survives the load path untouched', () => {
  withDashboard(
    {
      definition: {
        configSchema: [
          { key: 'url', type: 'url' },
          { key: 'password', type: 'secret' },
        ],
      },
    },
    ({ dashboard, seen }) => {
      dashboard.add({
        id: 'demo-1',
        type: 'demo',
        config: { url: 'http://service.invalid', password: SECRET_SET },
      });

      // `parseConfig` treats a secret as a string and must not reject the
      // sentinel — if it did, every widget with a saved credential would load
      // as an error tile.
      assert.equal(seen.length, 1);
      assert.equal(seen[0].password, SECRET_SET);
    }
  );
});

test('a dangling layout node does not stop the rest of the roster loading', () => {
  withDashboard({}, ({ dashboard, seen }) => {
    const roster = [
      { id: 'demo-1', type: 'demo', config: {} },
      { id: 'demo-2', type: 'demo', config: {} },
    ];
    const nodes = [
      { id: 'demo-1', x: 0, y: 0, w: 4, h: 2 },
      { id: 'deleted-widget', x: 4, y: 0, w: 4, h: 2 },
    ];

    const { roster: entries, usable } = reconcileRoster(roster, nodes);
    for (const entry of entries) dashboard.add(entry);

    // Both widgets rendered; the ghost node contributed nothing and blanked
    // nothing.
    assert.equal(seen.length, 2);
    assert.equal(usable.length, 1);
    assert.ok(dashboard.host('demo-1'));
    assert.ok(dashboard.host('demo-2'));
  });
});

test('removing a widget takes its search entries with it', () => {
  withDashboard({ definition: { searchable: true } }, ({ dashboard }) => {
    const host = dashboard.add({ id: 'demo-1', type: 'demo', config: {} });
    host.element.getSearchEntries = () => [{ id: 'e1', title: 'Findable' }];
    dashboard.reindexSearch();

    assert.equal(dashboard.searchIndex.search('Findable').length, 1);

    dashboard.remove('demo-1');

    // A deleted widget must stop being findable in the same turn it stops
    // being visible — a search hit that scrolls to a tile that is not there is
    // worse than no hit.
    assert.equal(dashboard.searchIndex.search('Findable').length, 0);
  });
});
