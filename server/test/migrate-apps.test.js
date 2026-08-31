import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { migrateRegistry } from '../../scripts/migrate-apps.mjs';

/**
 * Fixtures are hand-built in the OLD dashboard's shape, using `.invalid`
 * hostnames only. Nothing here is copied from the real `apps.json` — that file
 * maps the internal network and must never appear in this repo. See
 * docs/SECURITY.md.
 */
const oldApp = (overrides = {}) => ({
  id: 'example-service',
  name: 'Example Service',
  description: 'What this service is for.',
  category: 'tools',
  icon: 'example.svg',
  url: 'https://example.invalid',
  localUrl: 'https://example.local.invalid',
  localIpUrl: 'https://example-ip.invalid',
  remoteUrl: 'https://example.remote.invalid',
  tailscaleUrl: 'https://example.ts.invalid',
  releasesUrl: 'https://api.github.com/repos/example/example/releases/latest',
  containerId: 'example-container',
  ...overrides,
});

const migrateOne = (app) => {
  const { output, report } = migrateRegistry({ version: 1, apps: [app] });
  return { app: output.apps[0], report };
};

describe('migrate-apps field mapping', () => {
  test('maps every old URL field to its titled secondary, in probe order', () => {
    const { app } = migrateOne(oldApp());

    // The ORDER is the contract: reachability walks this array and stops at
    // the first responder, so a reordering changes where a click lands.
    //
    // `url` here is a distinct address from all four variants, so it becomes a
    // fifth entry titled "Open" and leads the list — with no localUrl match it
    // is the highest-priority thing known, and it carries `primary`.
    assert.deepEqual(
      app.urls.map((u) => u.title),
      ['Open', 'Open Local', 'Open Local via IP', 'Open Remote', 'Open via Tailscale']
    );
    assert.deepEqual(
      app.urls.map((u) => u.url),
      [
        'https://example.invalid',
        'https://example.local.invalid',
        'https://example-ip.invalid',
        'https://example.remote.invalid',
        'https://example.ts.invalid',
      ]
    );
    assert.deepEqual(
      app.urls.filter((u) => u.primary).map((u) => u.title),
      ['Open']
    );
  });

  test('maps releasesUrl and containerId onto version', () => {
    const { app } = migrateOne(oldApp());
    assert.equal(
      app.version.latestUrl,
      'https://api.github.com/repos/example/example/releases/latest'
    );
    assert.equal(app.version.currentContainerId, 'example-container');
  });

  test('preserves the five categories', () => {
    for (const category of ['personal', 'media', 'home', 'ai', 'tools']) {
      const { app } = migrateOne(oldApp({ category }));
      assert.equal(app.category, category);
    }
  });

  test('an unknown category falls back to tools and is reported', () => {
    const { app, report } = migrateOne(oldApp({ category: 'nonsense' }));
    assert.equal(app.category, 'tools');
    assert.match(report.recategorised.join(' '), /nonsense/);
  });

  test('the canonical url carries primary wherever it lands in the order', () => {
    // `url` equals `localUrl` here, so the primary rides on the first entry.
    const { app } = migrateOne(
      oldApp({
        url: 'https://example.local.invalid',
        localIpUrl: undefined,
        remoteUrl: undefined,
        tailscaleUrl: undefined,
      })
    );
    assert.equal(app.urls.length, 1);
    assert.equal(app.urls[0].primary, true);
    assert.equal(app.urls[0].url, 'https://example.local.invalid');
  });

  test('a url with no matching variant leads the list as "Open"', () => {
    const { app } = migrateOne(
      oldApp({
        localUrl: undefined,
        localIpUrl: undefined,
        remoteUrl: undefined,
        tailscaleUrl: undefined,
      })
    );
    assert.deepEqual(app.urls, [{ title: 'Open', url: 'https://example.invalid', primary: true }]);
  });

  test('exactly one primary is always produced', () => {
    for (const fixture of [
      oldApp(),
      oldApp({ url: undefined }),
      oldApp({ url: undefined, localUrl: undefined }),
    ]) {
      const { app } = migrateOne(fixture);
      assert.equal(app.urls.filter((u) => u.primary).length, 1, JSON.stringify(app.urls));
    }
  });

  test('with no canonical url the highest-priority variant is promoted', () => {
    const { app, report } = migrateOne(oldApp({ url: undefined }));
    assert.equal(app.urls[0].title, 'Open Local');
    assert.equal(app.urls[0].primary, true);
    assert.match(report.promoted.join(' '), /promoted "Open Local"/);
  });

  test('duplicate URLs are removed so a dead host is not probed twice', () => {
    const { app, report } = migrateOne(oldApp({ remoteUrl: 'https://example.local.invalid' }));
    const urls = app.urls.map((u) => u.url);
    assert.equal(new Set(urls).size, urls.length);
    assert.match(report.deduped.join(' '), /Open Remote/);
  });
});

describe('migrate-apps reporting', () => {
  test('reports unknown fields rather than dropping them silently', () => {
    const { report } = migrateOne(oldApp({ someNewField: 'x' }));
    assert.match(report.unknown.join(' '), /someNewField/);
  });

  test('reports deliberately dropped fields', () => {
    const { report } = migrateOne(oldApp({ restartUrl: 'https://example.invalid/restart' }));
    assert.match(report.dropped.join(' '), /restartUrl/);
    assert.equal(report.unknown.length, 0);
  });

  test('skips an entry with no id, and one with no usable URL', () => {
    const { output, report } = migrateRegistry({
      apps: [
        { name: 'No id' },
        oldApp({
          id: 'no-urls',
          url: undefined,
          localUrl: undefined,
          localIpUrl: undefined,
          remoteUrl: undefined,
          tailscaleUrl: undefined,
        }),
      ],
    });

    assert.deepEqual(output.apps, []);
    assert.equal(report.skipped.length, 2);
    assert.match(report.skipped.join(' '), /no id/);
    assert.match(report.skipped.join(' '), /no usable URLs/);
  });

  test('featured is a known field — it is not reported as unknown', () => {
    const { report } = migrateOne(oldApp({ featured: { tagline: 'x', image: 'y.png' } }));
    assert.equal(report.unknown.length, 0);
  });
});

describe('migrate-apps idempotency', () => {
  test('running twice over the same input gives the same output', () => {
    const input = { version: 1, apps: [oldApp(), oldApp({ id: 'second' })] };
    assert.deepEqual(migrateRegistry(input).output, migrateRegistry(input).output);
  });

  test('re-running over its OWN output is a no-op, not a double migration', () => {
    const first = migrateRegistry({ version: 1, apps: [oldApp()] }).output;
    const { output: second, report } = migrateRegistry(first);

    assert.deepEqual(second, first);
    assert.deepEqual(report.alreadyMigrated, ['example-service']);
    assert.equal(report.migrated.length, 0);
  });

  test('accepts a bare array as well as a { apps } wrapper', () => {
    assert.deepEqual(
      migrateRegistry([oldApp()]).output,
      migrateRegistry({ apps: [oldApp()] }).output
    );
  });
});
