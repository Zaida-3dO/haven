import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WidgetRegistry } from '../src/shell/registry.js';
import { greetingWidget } from '../src/widgets/greeting/definition.js';
import { heroWidget } from '../src/widgets/hero/definition.js';
import { noticesWidget } from '../src/widgets/notices/definition.js';
import { weatherWidget } from '../src/widgets/weather/definition.js';
import { iframeWidget } from '../src/widgets/iframe/definition.js';
import { pageWidget } from '../src/widgets/page/definition.js';

/**
 * The two widget definitions, asserted against the host's OWN registry — so a
 * definition the shell would reject fails here rather than at boot.
 *
 * These run against the real `WidgetRegistry` rather than a hand-copied stub,
 * deliberately: a stub would pass happily while the real registry rejected
 * exactly the same definition, which is worse than no test at all.
 */
const widgets = [
  ['weather', weatherWidget],
  ['greeting', greetingWidget],
  ['hero', heroWidget],
  ['notices', noticesWidget],
  ['iframe', iframeWidget],
  ['page', pageWidget],
];

/**
 * The subset that actually fetches.
 *
 * The iframe and page widgets declare no `dataSource` on purpose — an embed's
 * framed document does its own loading, and a custom page renders authored
 * content — so the endpoint and refresh-rate assertions below cannot apply to
 * them. Splitting the list is the honest way to say that; asserting
 * `refreshMs >= 60_000` against a widget whose `refreshMs` is `null` would
 * either fail or have to be fudged.
 */
const fetchingWidgets = widgets.filter(([, definition]) => definition.dataSource);

for (const [name, definition] of widgets) {
  test(`the ${name} widget registers against the real registry`, () => {
    const registry = new WidgetRegistry();

    assert.doesNotThrow(() => registry.register(definition));
    assert.equal(registry.get(definition.type).type, definition.type);
  });

  test(`the ${name} widget ships a stub config that validates`, () => {
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
  for (const [, definition] of fetchingWidgets) {
    const request = definition.dataSource({});
    assert.ok(request.url.startsWith('/api/'), 'the shell only ever calls /api/*');
    assert.equal(request.options?.headers, undefined, 'no widget sets an auth header');
  }
});

// ── the rule the contract calls the easiest one to get wrong ─────────────

/**
 * Every widget source EXCEPT the two shared-tick modules — `greeting/clock.js`
 * (the one host-owned timer) and `hero/rotation.js` (which subscribes to it).
 * Both are excluded on purpose: they are the thing that lets the widgets
 * themselves stay timer-free.
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
    'hero/index.js',
    'hero/element.js',
    'hero/definition.js',
    'hero/slides.js',
    'notices/index.js',
    'notices/element.js',
    'notices/definition.js',
    'notices/format.js',
    // The iframe widget is the strongest case for this scan: its whole job is
    // to render a user-supplied URL, so an innerHTML sink here would be a
    // stored-XSS hole rather than a style violation.
    'iframe/index.js',
    'iframe/element.js',
    'iframe/definition.js',
    'iframe/embed-url.js',
    'iframe/geometry.js',
    'page/index.js',
    'page/element.js',
    'page/definition.js',
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

  test(`${file} fetches no DATA of its own`, () => {
    // The host fetches; widgets render. A fetch here would also be the place
    // a credential eventually appears.
    assert.doesNotMatch(source, /XMLHttpRequest/, `${file} must not fetch`);

    if (file === 'notices/element.js') {
      // The one file that calls fetch at all, and only ever to WRITE on a user
      // gesture — a dismissal or an action button. That is not what this rule
      // forbids: there is no timer behind it, it cannot run in a hidden tab,
      // and it never fetches the widget's own data, which still arrives via
      // onData. The no-timer assertion above is what holds the line here.
      //
      // So instead of exempting the file, this pins the two properties that
      // make the exception safe: every call is a POST, and none is absolute.
      const methods = [...source.matchAll(/method:\s*'(\w+)'/g)].map((m) => m[1]);
      assert.ok(methods.length > 0, 'expected the write calls to still be present');
      for (const method of methods) {
        assert.equal(method, 'POST', 'a notices fetch must be a write, never a data read');
      }
      assert.doesNotMatch(source, /https?:\/\//, `${file} must never call an absolute URL`);
      return;
    }

    assert.doesNotMatch(source, /\bfetch\s*\(/, `${file} must not fetch — data arrives via onData`);
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
  for (const [name, definition] of fetchingWidgets) {
    assert.ok(definition.refreshMs >= 60_000, `${name} refreshes too aggressively`);
  }
});
