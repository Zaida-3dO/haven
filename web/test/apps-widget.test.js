import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { WidgetRegistry } from '../src/shell/registry.js';
import { buildFormModel, parseConfig } from '../src/shell/schema.js';
import { doneData } from '../src/shell/panel-data.js';
import { ALL_CATEGORY, SORT } from '../src/widgets/apps/model.js';
import {
  APPS_CONFIG_SCHEMA,
  WIDGET_TYPE,
  appsWidgetDefinition,
  dataSource,
  readPayload,
} from '../src/widgets/apps/apps-widget.js';

/**
 * These tests cover the widget's *definition* and its data contract — the
 * parts that do not need a DOM. Rendering logic is asserted through
 * `model.js` in `apps-model.test.js`, which is exactly why that module exists
 * separately: it keeps the untestable-without-a-browser surface down to
 * element creation.
 */

describe('apps widget definition', () => {
  test('registers against the shell registry', () => {
    const registry = new WidgetRegistry();
    const definition = registry.register(appsWidgetDefinition);

    assert.equal(definition.type, WIDGET_TYPE);
    assert.equal(definition.tag, 'haven-widget-apps');
    assert.ok(definition.searchable);
  });

  /**
   * The host owns every timer. If the widget ever declared no `refreshMs` the
   * dashboard would give it a null interval and it would never refresh — and
   * the only way to fix that from inside a widget is the `setInterval` the
   * contract forbids.
   */
  test('declares a refresh interval so the HOST can schedule it', () => {
    assert.ok(Number.isFinite(appsWidgetDefinition.refreshMs));
    assert.ok(appsWidgetDefinition.refreshMs > 0);
  });

  test('declares a mobile size so the grid works at the mobile breakpoint', () => {
    assert.ok(appsWidgetDefinition.mobileSize.w > 0);
    assert.ok(appsWidgetDefinition.mobileSize.h > 0);
  });

  test('ships a stub config that validates immediately', () => {
    const registry = new WidgetRegistry();
    registry.register(appsWidgetDefinition);

    const stub = registry.stubConfig(WIDGET_TYPE);

    // "Add widget" must produce something that WORKS, not an error card.
    assert.doesNotThrow(() => parseConfig(APPS_CONFIG_SCHEMA, stub));
    assert.equal(stub.configVersion, 1);
  });

  test('carries a config version so saved layouts can be migrated later', () => {
    assert.equal(appsWidgetDefinition.configVersion, 1);
  });
});

describe('apps configSchema', () => {
  /**
   * The settings UI is GENERATED from this array — no widget writes its own
   * form. This asserts the array is actually consumable by the shell's form
   * builder, which is the thing that would break if someone hand-built a form
   * instead.
   */
  test('generates a settings form through the shell, not by hand', () => {
    const model = buildFormModel(APPS_CONFIG_SCHEMA, {});

    assert.ok(model.length >= 4);
    const category = model.find((f) => f.key === 'category');
    assert.equal(category.type, 'select');
    assert.ok(category.options.some((o) => o.value === ALL_CATEGORY));
  });

  test('every field is one of the contract types', () => {
    const allowed = new Set(['url', 'number', 'text', 'select', 'secret']);
    for (const field of APPS_CONFIG_SCHEMA) assert.ok(allowed.has(field.type), field.key);
  });

  /**
   * Visit counts are server-owned and NOT user-editable (DESIGN §6.2). A
   * settings field for them would contradict the API, which rejects a client
   * that tries to set one.
   */
  test('offers no field for visit counts', () => {
    assert.ok(!APPS_CONFIG_SCHEMA.some((f) => /visit/i.test(f.key)));
  });

  test('offers visit-count as a sort option', () => {
    const sort = APPS_CONFIG_SCHEMA.find((f) => f.key === 'sort');
    assert.ok(sort.options.some((o) => o.value === SORT.VISITS));
  });

  test('rejects a sort value that is not an option', () => {
    assert.throws(() => parseConfig(APPS_CONFIG_SCHEMA, { sort: 'by-vibes' }), /sort/);
  });

  test('rejects a re-probe interval below the floor', () => {
    assert.throws(() => parseConfig(APPS_CONFIG_SCHEMA, { statusTtlMs: 10 }), /statusTtlMs/);
  });

  test('applies defaults for an empty config', () => {
    const parsed = parseConfig(APPS_CONFIG_SCHEMA, {});

    assert.equal(parsed.category, ALL_CATEGORY);
    assert.equal(parsed.sort, SORT.VISITS);
    assert.equal(parsed.showVersions, 'on');
  });
});

describe('dataSource', () => {
  /**
   * The browser must never call GitHub directly — the token lives on the
   * server. Every URL this widget asks for is a local `/api/*` path.
   */
  test('only ever requests a local /api path', () => {
    for (const config of [{}, { category: 'media' }, { showVersions: 'off' }]) {
      assert.match(dataSource(config).url, /^\/api\//);
    }
  });

  test('never points at an external host', () => {
    const url = dataSource({ category: 'media' }).url;
    assert.ok(!url.includes('github.com'));
    assert.ok(!url.startsWith('http'));
  });

  test('asks for one combined response rather than two requests', () => {
    const request = dataSource({});

    // The host's contract is one descriptor per widget, so the join is the
    // server's job.
    assert.equal(typeof request.url, 'string');
    assert.match(request.url, /\/api\/apps\/dashboard/);
  });

  /**
   * The configured category must NOT be sent to the server. The widget has
   * category TABS, and the config field only picks which one it opens on — so
   * a server-filtered payload could only ever contain one category, and every
   * other tab would be unclickable because its apps were never fetched.
   */
  test('never sends the category to the server, so the tabs stay usable', () => {
    assert.ok(!dataSource({ category: 'media' }).url.includes('category='));
    assert.ok(!dataSource({ category: ALL_CATEGORY }).url.includes('category='));
  });

  test('skips version work when versions are hidden', () => {
    assert.match(dataSource({ showVersions: 'off' }).url, /versions=false/);
  });

  /** Two identical widgets must collapse to one request in the fetcher. */
  test('two widgets with the same config share a cache key', () => {
    assert.equal(dataSource({ category: 'media' }).key, dataSource({ category: 'media' }).key);
  });

  /**
   * Every widget fetches the same full list, so widgets configured for
   * different categories genuinely share one cached response.
   */
  test('widgets on different categories share one request', () => {
    assert.equal(dataSource({ category: 'media' }).key, dataSource({ category: 'ai' }).key);
    assert.equal(dataSource({ category: 'media' }).url, dataSource({ category: 'ai' }).url);
  });

  test('hiding versions does not share a key with showing them', () => {
    assert.notEqual(dataSource({}).key, dataSource({ showVersions: 'off' }).key);
  });
});

describe('readPayload', () => {
  test('reads the combined shape', () => {
    const { apps, versions } = readPayload({
      apps: [{ id: 'a' }],
      versions: { a: { current: '1.0.0' } },
    });

    assert.equal(apps.length, 1);
    assert.equal(versions.a.current, '1.0.0');
  });

  test('tolerates a bare array of apps', () => {
    assert.equal(readPayload([{ id: 'a' }]).apps.length, 1);
  });

  /**
   * The host pushes a loading payload with a null value before the first
   * fetch lands. That must render an empty grid, not throw.
   */
  test('a null value is empty rather than an error', () => {
    assert.deepEqual(readPayload(null), { apps: [], versions: {} });
    assert.deepEqual(readPayload(undefined), { apps: [], versions: {} });
  });

  test('a payload with no versions key still yields apps', () => {
    const { apps, versions } = readPayload({ apps: [{ id: 'a' }] });

    assert.equal(apps.length, 1);
    assert.deepEqual(versions, {});
  });

  test('reads a real host payload', () => {
    const payload = doneData({ apps: [{ id: 'a' }], versions: {} });
    assert.equal(readPayload(payload.value).apps.length, 1);
  });
});
