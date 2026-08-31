import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { greetingWidget } from '../src/widgets/greeting/definition.js';
import { weatherWidget } from '../src/widgets/weather/definition.js';

/**
 * The two widget definitions, asserted against the contract.
 *
 * Where possible they are asserted against the host's OWN registry, so a
 * definition the shell would reject fails here rather than at boot. The widget
 * host is being built in parallel on its own branch, though, so
 * `src/shell/registry.js` may not be present yet — those tests skip rather
 * than fail while it is missing, and start running the moment the host lands.
 *
 * Skipping is deliberate. The alternative — hand-copying a stub of the
 * registry into this file — would pass happily while the real registry
 * rejected exactly the same definition, which is worse than no test at all.
 */
const { WidgetRegistry } = await import('../src/shell/registry.js').catch(() => ({}));
const hostPresent = typeof WidgetRegistry === 'function';
const skipWithoutHost = hostPresent
  ? false
  : 'the widget host branch is not merged yet — src/shell/registry.js is absent';

const widgets = [
  ['weather', weatherWidget],
  ['greeting', greetingWidget],
];

for (const [name, definition] of widgets) {
  test(`the ${name} widget registers against the real registry`, { skip: skipWithoutHost }, () => {
    const registry = new WidgetRegistry();

    assert.doesNotThrow(() => registry.register(definition));
    assert.equal(registry.get(definition.type).type, definition.type);
  });

  test(`the ${name} widget ships a stub config that validates`, { skip: skipWithoutHost }, () => {
    // getStubConfig is what makes "Add widget" produce something that works
    // immediately instead of an error card.
    const registry = new WidgetRegistry();
    registry.register(definition);

    const stub = registry.stubConfig(definition.type);

    assert.equal(stub.configVersion, definition.configVersion);
    assert.doesNotThrow(() => definition.getStubConfig());
  });

  test(`the ${name} widget declares a version so its config can be migrated`, () => {
    assert.ok(Number.isInteger(definition.configVersion), 'config versioning is not optional');
  });

  test(`the ${name} widget's configSchema is a flat array of typed descriptors`, () => {
    // Asserted here as well as through the registry, so the schema still has
    // real coverage while the host branch is unmerged. The five types are the
    // ones docs/WIDGET-CONTRACT.md allows.
    const allowed = ['url', 'number', 'text', 'select', 'secret'];
    const keys = new Set();

    assert.ok(Array.isArray(definition.configSchema));

    for (const field of definition.configSchema) {
      assert.ok(typeof field.key === 'string' && field.key !== '', 'every field needs a key');
      assert.ok(!keys.has(field.key), `duplicate key ${field.key}`);
      keys.add(field.key);
      assert.ok(allowed.includes(field.type), `${field.key} has unknown type ${field.type}`);
      if (field.type === 'select') {
        assert.ok(Array.isArray(field.options), `${field.key} needs an options array`);
      }
      // Not JSON Schema — a nested `properties` object means someone reached
      // for the wrong shape.
      assert.equal(field.properties, undefined, 'configSchema is not JSON Schema');
    }
  });

  test(`the ${name} widget's stub config only sets keys its schema declares`, () => {
    const declared = new Set(definition.configSchema.map((f) => f.key));

    for (const key of Object.keys(definition.getStubConfig())) {
      assert.ok(declared.has(key), `stub config sets undeclared key "${key}"`);
    }
  });

  test(`the ${name} widget declares sizes the grid can use`, () => {
    for (const key of ['defaultSize', 'minSize', 'mobileSize']) {
      assert.ok(definition[key].w >= 1 && definition[key].h >= 1, `${key} must be at least 1x1`);
    }
    assert.ok(definition.defaultSize.w >= definition.minSize.w);
    assert.ok(definition.defaultSize.h >= definition.minSize.h);
  });
}

// ── the host fetches; widgets render ─────────────────────────────────────

test('both widgets ask for the same endpoint under the same fetcher key', () => {
  const weather = weatherWidget.dataSource({});
  const greeting = greetingWidget.dataSource({});

  assert.equal(weather.url, '/api/widgets/weather');
  assert.equal(greeting.url, weather.url);
  // The shared key is what makes the fetcher collapse both into ONE request,
  // so having both widgets on the board costs one call rather than two.
  assert.equal(greeting.key, weather.key, 'a shared key is what dedupes the two widgets');
});

test('neither widget requests a credentialed URL', () => {
  for (const [, definition] of widgets) {
    const request = definition.dataSource({});
    assert.ok(request.url.startsWith('/api/'), 'the shell only ever calls /api/*');
    assert.equal(request.options?.headers, undefined, 'no widget sets an auth header');
  }
});

// ── the rule the contract calls the easiest one to get wrong ─────────────

/**
 * Every widget source EXCEPT `greeting/clock.js`, which is the one
 * host-owned timer and is excluded on purpose — it is the thing that lets the
 * widgets themselves stay timer-free.
 */
const sources = Object.fromEntries(
  [
    'weather/index.js',
    'weather/element.js',
    'weather/definition.js',
    'weather/format.js',
    'greeting/index.js',
    'greeting/element.js',
    'greeting/definition.js',
    'greeting/phrases.js',
  ].map((file) => [
    file,
    stripComments(readFileSync(new URL(`../src/widgets/${file}`, import.meta.url), 'utf8')),
  ])
);

/**
 * Strip comments before scanning.
 *
 * Without this the checks below match their own documentation: these files
 * explain at length that a widget must never call `setInterval` and never set
 * `innerHTML`, and a naive scan reads those sentences as violations. Removing
 * comments is what makes the assertion mean "the CODE does not do this".
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

for (const [file, source] of Object.entries(sources)) {
  test(`${file} calls no timer of its own`, () => {
    // "A widget must never call setInterval" — the single easiest way to get
    // this design wrong, so it is asserted rather than trusted. The shared
    // ticker in greeting/clock.js is the one host-owned timer and is
    // deliberately excluded from this list.
    assert.doesNotMatch(source, /\bsetInterval\b/, `${file} must not own a timer`);
    assert.doesNotMatch(source, /\bsetTimeout\b/, `${file} must not own a timer`);
  });

  test(`${file} fetches nothing itself`, () => {
    // The host fetches; widgets render. A fetch here would also be the place
    // a credential eventually appears.
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${file} must not fetch — data arrives via onData`);
    assert.doesNotMatch(source, /XMLHttpRequest/, `${file} must not fetch`);
  });

  test(`${file} sets no innerHTML`, () => {
    // Weather descriptions and the connector's hint are upstream strings;
    // they are only ever set as textContent.
    assert.doesNotMatch(source, /innerHTML/, `${file} must not build markup from strings`);
  });
}

test('no widget source mentions an API key or a credential', () => {
  for (const [file, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /appid=/i, `${file} must not build an upstream URL`);
    assert.doesNotMatch(source, /openweathermap\.org\/data/i, `${file} must not call upstream`);
    assert.doesNotMatch(source, /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i, `${file} holds a key`);
  }
});

// ── refresh rates ────────────────────────────────────────────────────────

test('refreshMs is the host schedule, and is not a per-second poll', () => {
  // A widget that asked the host to refetch every second would defeat the
  // server-side cache the connector exists to provide.
  for (const [name, definition] of widgets) {
    assert.ok(definition.refreshMs >= 60_000, `${name} refreshes too aggressively`);
  }
});
