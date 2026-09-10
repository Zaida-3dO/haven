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

/**
 * `featured` survived a silent drop for a whole release BECAUSE of the test
 * directly above this block.
 *
 * That test asserts `featured` raises no "unknown field" warning — which was
 * true, and stayed true, while `migrateApp` threw the field away. The return is
 * a whitelist and `featured` was not on it; being in KNOWN_FIELDS only bought
 * silence from the reporter. So the one test naming the field asserted the
 * quietness and never the survival, and read as coverage.
 *
 * The lesson these tests encode: assert the field ARRIVES, not merely that
 * nothing complained about it.
 */
describe('migrate-apps carries featured through', () => {
  const featured = { tagline: 'The one you actually open', cover: 'hero.png' };

  test('an OLD-SHAPE app keeps its featured block', () => {
    const { app } = migrateOne(oldApp({ featured }));

    // The regression. Before the fix this was `undefined`: the block died in
    // migrateApp, seed-plan then compared null to null, and the seeder
    // truthfully reported "skip" over data that no longer existed — a hero
    // that stayed empty with nothing anywhere reporting a problem.
    assert.deepEqual(app.featured, featured);
  });

  test('an app with no featured block does not gain one', () => {
    const { app } = migrateOne(oldApp());

    // The other half of the contract: `featured` is spread in conditionally,
    // so absent must stay absent rather than becoming an explicit `undefined`
    // or `null` that would then read as a change against a clean server.
    assert.equal('featured' in app, false);
  });

  test('a NEW-SHAPE app keeps its featured block too', () => {
    // This shape always worked — isAlreadyMigrated passes anything with a
    // `urls` array straight through — and that is exactly why the bug looked
    // intermittent. Pinned so a future rewrite of the passthrough cannot
    // quietly regress the case that was fine.
    const { app } = migrateOne({
      id: 'modern-service',
      name: 'Modern Service',
      category: 'tools',
      urls: [{ title: 'Open', url: 'https://modern.invalid', primary: true }],
      featured,
    });

    assert.deepEqual(app.featured, featured);
  });

  test('re-running over its own output keeps featured stable', () => {
    const first = migrateRegistry({ version: 1, apps: [oldApp({ featured })] }).output;
    const second = migrateRegistry(first).output;

    assert.deepEqual(second, first);
    assert.deepEqual(second.apps[0].featured, featured);
  });

  /**
   * The DEFECT CLASS, not the instance.
   *
   * `featured` was an orphan: a field the migration claimed to know about
   * (KNOWN_FIELDS) but silently declined to emit. Rather than pin the one
   * field that was broken, this walks every known field and asserts each is
   * either accounted for by a mapping or present on the output — so the next
   * field added to KNOWN_FIELDS and forgotten in the return fails here.
   */
  test('every known field is either mapped or carried — none silently vanish', () => {
    const { app } = migrateOne(oldApp({ featured }));

    // Old fields that legitimately do not appear under their own name because
    // they are folded into a structure.
    const foldedIntoUrls = ['url', 'localUrl', 'localIpUrl', 'remoteUrl', 'tailscaleUrl'];
    const foldedIntoVersion = ['releasesUrl', 'containerId'];

    const source = oldApp({ featured });
    const unaccounted = Object.keys(source).filter(
      (field) =>
        !foldedIntoUrls.includes(field) && !foldedIntoVersion.includes(field) && !(field in app)
    );

    assert.deepEqual(
      unaccounted,
      [],
      `these known fields were dropped by migrateApp's return whitelist: ${unaccounted.join(', ')}`
    );

    // And the two folds really did happen, so the exemptions above cannot be
    // used to excuse a field that went missing entirely.
    assert.ok(app.urls.length > 0, 'url fields should have folded into urls');
    assert.equal(app.version.latestUrl, source.releasesUrl);
    assert.equal(app.version.currentContainerId, source.containerId);
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
