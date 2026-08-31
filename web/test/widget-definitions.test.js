import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WidgetRegistry } from '../src/shell/registry.js';
import { greetingWidget } from '../src/widgets/greeting/definition.js';
import { heroWidget } from '../src/widgets/hero/definition.js';
import { noticesWidget } from '../src/widgets/notices/definition.js';
import { weatherWidget } from '../src/widgets/weather/definition.js';

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
];

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
  for (const [, definition] of widgets) {
    const request = definition.dataSource({});
    assert.ok(request.url.startsWith('/api/'), 'the shell only ever calls /api/*');
    assert.equal(request.options?.headers, undefined, 'no widget sets an auth header');
  }
});

// ── the rule the contract calls the easiest one to get wrong ─────────────

/**
 * Every widget source, discovered by walking `src/widgets` — NOT a hand-kept
 * list.
 *
 * **Why a glob.** This was a literal array of sixteen paths covering four
 * widget directories, which meant the ten files under `apps/`, `calendar/`,
 * `clock/` and `torrents/` were exempt from all three invariants below. They
 * happened to comply, so nothing was broken — but enforcement was absent
 * exactly where the next widget would be added, which is how the gap arose in
 * the first place. A glob makes a new widget scanned by default, so forgetting
 * to opt in is no longer possible.
 */
const TIMER_EXEMPT = new Set([
  // The two shared-tick modules, excluded on purpose: `greeting/clock.js` is
  // the one host-owned timer and `hero/rotation.js` subscribes to it. They are
  // the thing that lets every other widget module stay timer-free.
  'greeting/clock.js',
  'hero/rotation.js',
]);

/** Every `.js` file under `src/widgets`, as a `dir/file.js` relative path. */
function widgetSourceFiles() {
  const root = new URL('../src/widgets/', import.meta.url);
  const files = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const entry of readdirSync(new URL(`${dir.name}/`, root), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js')) files.push(`${dir.name}/${entry.name}`);
    }
  }
  return files.sort();
}

const sources = Object.fromEntries(
  widgetSourceFiles().map((file) => [
    file,
    stripComments(readFileSync(new URL(`../src/widgets/${file}`, import.meta.url), 'utf8')),
  ])
);

test('the widget scan actually covers every widget directory', () => {
  // Guards the glob itself: if `widgetSourceFiles` silently returned nothing
  // (a bad URL, a rename), every invariant below would vacuously pass.
  const dirs = new Set(Object.keys(sources).map((f) => f.split('/')[0]));
  for (const expected of [
    'apps',
    'calendar',
    'clock',
    'greeting',
    'hero',
    'notices',
    'torrents',
    'weather',
  ]) {
    assert.ok(dirs.has(expected), `${expected}/ must be scanned`);
  }
  assert.ok(Object.keys(sources).length >= 25, 'expected the whole widget tree, not a subset');
});

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
  test(`${file} calls no timer of its own`, { skip: TIMER_EXEMPT.has(file) }, () => {
    // "A widget must never call setInterval" — the single easiest way to get
    // this design wrong, so it is asserted rather than trusted. The two
    // shared-tick modules in TIMER_EXEMPT are the host-owned timer and its
    // subscriber, and are the only deliberate exceptions.
    assert.doesNotMatch(source, /\bsetInterval\b/, `${file} must not own a timer`);
    assert.doesNotMatch(source, /\bsetTimeout\b/, `${file} must not own a timer`);
  });

  test(`${file} fetches no DATA of its own`, () => {
    // The host fetches; widgets render. A fetch here would also be the place
    // a credential eventually appears.
    assert.doesNotMatch(source, /XMLHttpRequest/, `${file} must not fetch`);

    // A widget may call `fetch` ONLY to write on a user gesture — a notices
    // dismissal, an apps visit count. That is not what this rule forbids:
    // there is no timer behind it, it cannot run in a hidden tab, and it never
    // fetches the widget's own data, which still arrives via onData. The
    // no-timer assertion above is what holds the line.
    //
    // **Counting the call sites is the whole point.** This previously
    // collected `method:` literals and required each to be POST, without ever
    // counting `fetch(` — so the two could diverge silently, and a bare
    // `fetch(url)`, which defaults to GET, was invisible to it. Requiring one
    // POST literal PER call site closes that: an unmethodded read can no
    // longer hide behind a sibling write.
    const calls = [...source.matchAll(/\bfetch\s*\(/g)].length;
    if (calls === 0) return;

    const posts = [...source.matchAll(/method:\s*'POST'/g)].length;
    assert.equal(
      posts,
      calls,
      `${file}: ${calls} fetch call site(s) but ${posts} POST(s) — every widget fetch ` +
        'must be an explicit write; a fetch with no method is a GET, which is a data read'
    );

    // Scoped to files that actually fetch, deliberately. An absolute URL
    // elsewhere is not a network call: `new URL(value, 'https://haven.invalid')`
    // is a parser base, and weather/format.js builds an <img> src for the icon
    // CDN. Asserting this tree-wide would fail all three for no defect.
    for (const [, url] of source.matchAll(/\bfetch\s*\(\s*([^,)]*)/g)) {
      assert.doesNotMatch(url, /https?:\/\//, `${file} must never fetch an absolute URL`);
    }
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
