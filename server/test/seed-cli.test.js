import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { migrate } from '../src/db/migrate.js';
import { SECRET_SET, secretName } from '../src/db/instances-store.js';
import { buildServer } from '../src/server.js';
import { applySeed, exportSeed, resolveSeed } from '../../scripts/lib/seed-apply.mjs';
import { createClient } from '../../scripts/lib/seed-client.mjs';
import { stripUntouchedSecrets } from '../../scripts/lib/seed-plan.mjs';
import { SeedValidationError, validateSeed } from '../../scripts/lib/seed-schema.mjs';
import { injectFetch } from './helpers/inject-fetch.js';

/**
 * Every fixture below uses `.invalid` hostnames and invented ids. Nothing here
 * is copied from a real dashboard — a seed file maps the whole internal
 * network, which is precisely why this tool's docs shout about not committing
 * one. See docs/SECURITY.md.
 */

/** An in-memory credential store double — same pattern as `instances.test.js`. */
function fakeCredentials() {
  const values = new Map();
  return {
    values,
    set(name, value) {
      values.set(name, value);
      return { name };
    },
    get(name) {
      return values.has(name) ? values.get(name) : null;
    },
    delete(name) {
      return values.delete(name);
    },
  };
}

/**
 * A server on a private in-memory DB, plus a client wired straight into it.
 *
 * The roster is emptied AFTER `buildServer`, not prevented from seeding:
 * `seedInstances` falls back to the built-in `DEFAULT_INSTANCES` when its file
 * is missing — deliberately, so a fresh install is not a blank page — and
 * there is no option that turns that off. Six default widgets in the way would
 * make every assertion here about the defaults rather than about the seeder.
 */
async function freshHaven(t, { iconDir } = {}) {
  const db = new Database(':memory:');
  migrate(db);

  const credentials = fakeCredentials();
  const app = await buildServer({
    logger: false,
    db,
    credentials,
    // Paths that cannot exist, so this suite never depends on whatever
    // config/*.json happens to hold on the machine running it.
    seedPath: '/nonexistent/apps.invalid.json',
    instancesSeedPath: '/nonexistent/instances.invalid.json',
    ...(iconDir ? { iconDir } : {}),
  });

  db.prepare('DELETE FROM widgets').run();
  db.prepare('DELETE FROM layout').run();

  t.after(async () => {
    await app.close();
    db.close();
  });

  const client = createClient({ baseUrl: 'http://haven.invalid', fetchImpl: injectFetch(app) });
  return { app, db, client, credentials };
}

const app1 = {
  id: 'example-service',
  name: 'Example Service',
  description: 'What this service is for.',
  category: 'tools',
  urls: [{ title: 'Open', url: 'https://example.invalid', primary: true }],
};

const seedDoc = (overrides = {}) => ({
  version: 1,
  apps: [app1],
  instances: [{ id: 'clock-local', type: 'clock', config: { label: 'Local time' } }],
  layout: { desktop: [{ id: 'clock-local', x: 0, y: 0, w: 3, h: 2 }] },
  ...overrides,
});

// ── Applying ─────────────────────────────────────────────────────────────

test('apply creates apps, instances and layout from one file', async (t) => {
  const { client } = await freshHaven(t);

  const result = await applySeed({ client, doc: seedDoc() });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.results.map((r) => [r.kind, r.id, r.action]),
    [
      ['app', 'example-service', 'created'],
      ['instance', 'clock-local', 'created'],
      // No `mobile` row: the file does not mention that breakpoint, so it is
      // left alone entirely rather than reported as an untouched no-op. That
      // matches `PUT /api/layout`, where a payload with only `desktop` leaves
      // `mobile` as it was.
      ['layout', 'desktop', 'created'],
    ]
  );

  const apps = await client.listApps();
  assert.equal(apps.length, 1);
  assert.equal(apps[0].name, 'Example Service');

  const layout = await client.getLayout();
  assert.deepEqual(layout.desktop, [{ id: 'clock-local', x: 0, y: 0, w: 3, h: 2 }]);
});

/**
 * THE idempotency test. A second apply of an unchanged file must converge, not
 * duplicate and not churn.
 *
 * Asserting on the ACTION rather than just the row count is what makes this
 * bite: a second apply that re-PUT everything would still leave one app, so a
 * count-only assertion would pass while the tool pointlessly rewrote the whole
 * dashboard on every run. "skipped" is the claim being made.
 */
test('a second apply of the same file changes nothing', async (t) => {
  const { client } = await freshHaven(t);

  await applySeed({ client, doc: seedDoc() });
  const second = await applySeed({ client, doc: seedDoc() });

  assert.equal(second.ok, true);
  assert.deepEqual(
    second.results.map((r) => r.action),
    ['skipped', 'skipped', 'skipped'],
    'every item should be skipped on an unchanged re-apply'
  );

  assert.equal((await client.listApps()).length, 1, 'apps must not duplicate');
  assert.equal((await client.listInstances()).length, 1, 'instances must not duplicate');
  assert.equal((await client.getLayout()).desktop.length, 1, 'layout nodes must not duplicate');
});

test('editing one app updates only that app', async (t) => {
  const { client } = await freshHaven(t);

  await applySeed({
    client,
    doc: seedDoc({
      apps: [app1, { ...app1, id: 'second-service', name: 'Second Service' }],
    }),
  });

  const result = await applySeed({
    client,
    doc: seedDoc({
      apps: [
        { ...app1, name: 'Renamed Service' },
        { ...app1, id: 'second-service', name: 'Second Service' },
      ],
    }),
  });

  const appRows = result.results.filter((r) => r.kind === 'app');
  assert.deepEqual(
    appRows.map((r) => [r.id, r.action]),
    [
      ['example-service', 'updated'],
      ['second-service', 'skipped'],
    ]
  );

  const apps = await client.listApps();
  assert.equal(apps.find((a) => a.id === 'example-service').name, 'Renamed Service');
});

// ── Dry run ──────────────────────────────────────────────────────────────

test('--dry-run reports what would change and changes nothing', async (t) => {
  const { client } = await freshHaven(t);

  const result = await applySeed({ client, doc: seedDoc(), dryRun: true });

  assert.equal(result.dryRun, true);
  assert.deepEqual(
    result.results.map((r) => r.action),
    ['would create', 'would create', 'would create']
  );

  assert.equal((await client.listApps()).length, 0, 'a dry run must not write');
  assert.equal((await client.listInstances()).length, 0, 'a dry run must not write');
  assert.deepEqual((await client.getLayout()).desktop, [], 'a dry run must not write');
});

// ── Failure reporting ────────────────────────────────────────────────────

test('a failing item is named, and the run reports not-ok', async (t) => {
  const { client } = await freshHaven(t);

  const result = await applySeed({
    client,
    doc: seedDoc({
      apps: [
        app1,
        // Rejected by `apps-schema.js`: exactly one url must be primary.
        { id: 'broken-service', name: 'Broken', urls: [] },
      ],
      instances: [],
      layout: {},
    }),
  });

  assert.equal(result.ok, false);

  const failed = result.results.filter((r) => r.action === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].id, 'broken-service');
  assert.match(failed[0].detail, /400/);

  // The item that DID land is still reported as landed — partial failure has
  // to be legible, not collapsed into "the run failed".
  assert.ok(
    result.results.some((r) => r.id === 'example-service' && r.action === 'created'),
    'the app that succeeded must still be reported as created'
  );
  assert.equal((await client.listApps()).length, 1);
});

test('a layout node naming an unknown instance fails before anything is written', async (t) => {
  const { client } = await freshHaven(t);

  await assert.rejects(
    applySeed({
      client,
      doc: seedDoc({
        layout: { desktop: [{ id: 'ghost-widget', x: 0, y: 0, w: 3, h: 2 }] },
      }),
    }),
    (err) => err instanceof SeedValidationError && /ghost-widget/.test(err.message)
  );

  assert.equal(
    (await client.listApps()).length,
    0,
    'nothing may be written when the layout is known-bad up front'
  );
});

test('a layout node may name an instance the same file creates', async (t) => {
  const { client } = await freshHaven(t);

  const result = await applySeed({
    client,
    doc: seedDoc({
      instances: [{ id: 'brand-new', type: 'clock', config: {} }],
      layout: { desktop: [{ id: 'brand-new', x: 0, y: 0, w: 3, h: 2 }] },
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual((await client.getLayout()).desktop, [
    { id: 'brand-new', x: 0, y: 0, w: 3, h: 2 },
  ]);
});

// ── Secrets ──────────────────────────────────────────────────────────────

/**
 * THE secret test. A round trip must not wipe a stored credential.
 *
 * The shape of the trap: the instances API returns `SECRET_SET` where a
 * credential is stored, never the credential. An `export` therefore captures
 * the sentinel, and a naive `apply` would send it straight back — storing the
 * literal string `__haven_secret_set__` AS the password. Sending `''` instead
 * would delete it. The only correct move is to OMIT the key, which is what
 * `stripUntouchedSecrets` does and what this asserts.
 */
test('a stored secret survives an export/apply round trip unchanged', async (t) => {
  const { client, credentials } = await freshHaven(t);

  await applySeed({
    client,
    doc: seedDoc({
      apps: [],
      layout: {},
      instances: [
        {
          id: 'private-feed',
          type: 'calendar',
          config: { title: 'Calendar', icsUrl: 'https://calendar.invalid/feed.ics' },
          secretKeys: ['icsUrl'],
        },
      ],
    }),
  });

  const name = secretName('private-feed', 'icsUrl');
  assert.equal(credentials.get(name), 'https://calendar.invalid/feed.ics');

  // What a user would actually do: capture the live dashboard, then re-apply.
  const exported = await exportSeed(client);
  assert.equal(
    exported.instances[0].config.icsUrl,
    SECRET_SET,
    'export must not invent a secret — it can only see the sentinel'
  );

  const result = await applySeed({ client, doc: exported });
  assert.equal(result.ok, true);

  assert.equal(
    credentials.get(name),
    'https://calendar.invalid/feed.ics',
    'the stored credential must survive the round trip untouched'
  );
  assert.notEqual(
    credentials.get(name),
    SECRET_SET,
    'the sentinel must never be stored as a value'
  );
  assert.notEqual(credentials.get(name), '', 'the credential must not be blanked');
});

test('an instance holding only a stored secret is skipped, not endlessly updated', async (t) => {
  const { client } = await freshHaven(t);

  const doc = seedDoc({
    apps: [],
    layout: {},
    instances: [
      {
        id: 'private-feed',
        type: 'calendar',
        config: { icsUrl: 'https://calendar.invalid/feed.ics' },
        secretKeys: ['icsUrl'],
      },
    ],
  });

  await applySeed({ client, doc });
  const exported = await exportSeed(client);
  const second = await applySeed({ client, doc: exported });

  assert.deepEqual(
    second.results.filter((r) => r.kind === 'instance').map((r) => r.action),
    ['skipped'],
    'a secret-only difference is not a difference — it is all that can be seen'
  );
});

test('an explicit empty string clears a secret, but the sentinel does not', () => {
  const secretKeys = new Set(['token']);

  assert.deepEqual(
    stripUntouchedSecrets({ token: SECRET_SET, other: 'x' }, secretKeys),
    { config: { other: 'x' }, omitted: ['token'] },
    'the sentinel must be omitted so the server preserves what it holds'
  );

  assert.deepEqual(
    stripUntouchedSecrets({ token: '' }, secretKeys),
    { config: { token: '' }, omitted: [] },
    'an explicit blank is a deliberate clear and must be sent'
  );

  assert.deepEqual(
    stripUntouchedSecrets({ token: 'new-value' }, secretKeys),
    { config: { token: 'new-value' }, omitted: [] },
    'a real new value must be sent'
  );
});

// ── Export ───────────────────────────────────────────────────────────────

test('export produces a document that re-applies as entirely skipped', async (t) => {
  const { client } = await freshHaven(t);

  await applySeed({ client, doc: seedDoc() });
  const exported = await exportSeed(client);

  assert.equal(exported.version, 1);
  assert.ok(
    !('visitCount' in exported.apps[0]),
    'visitCount is server-owned and is REJECTED on write'
  );

  const result = await applySeed({ client, doc: exported });
  assert.equal(result.ok, true);
  assert.ok(
    result.results.every((r) => r.action === 'skipped'),
    `a captured dashboard must re-apply clean, got: ${JSON.stringify(result.results)}`
  );
});

// ── The old dashboard's shape ────────────────────────────────────────────

test('apply accepts the old dashboard app shape and maps it through migrate-apps', async (t) => {
  const { client } = await freshHaven(t);

  const result = await applySeed({
    client,
    doc: seedDoc({
      apps: [
        {
          id: 'legacy-service',
          name: 'Legacy Service',
          category: 'media',
          url: 'https://legacy.invalid',
          localUrl: 'https://legacy.local.invalid',
          tailscaleUrl: 'https://legacy.ts.invalid',
          releasesUrl: 'https://api.github.invalid/releases/latest',
        },
      ],
      instances: [],
      layout: {},
    }),
  });

  assert.equal(result.ok, true);

  const [app] = await client.listApps();
  // The ORDER is the contract — reachability probes it in this sequence.
  assert.deepEqual(
    app.urls.map((u) => u.title),
    ['Open', 'Open Local', 'Open via Tailscale']
  );
  assert.deepEqual(
    app.urls.filter((u) => u.primary).map((u) => u.url),
    ['https://legacy.invalid']
  );
  assert.equal(app.version.latestUrl, 'https://api.github.invalid/releases/latest');
});

test('a file may mix old-shape and new-shape apps', async (t) => {
  const { client } = await freshHaven(t);

  const result = await applySeed({
    client,
    doc: seedDoc({
      apps: [app1, { id: 'legacy-service', name: 'Legacy', url: 'https://legacy.invalid' }],
      instances: [],
      layout: {},
    }),
  });

  assert.equal(result.ok, true);
  assert.equal((await client.listApps()).length, 2);
});

test('resolveSeed carries iconFile around the migration mapping', () => {
  const resolved = resolveSeed({
    apps: [
      { id: 'legacy-service', name: 'Legacy', url: 'https://legacy.invalid', iconFile: './a.png' },
    ],
  });

  assert.equal(resolved.apps[0].iconFile, './a.png');
  assert.equal(resolved.apps[0].urls[0].url, 'https://legacy.invalid');
});

// ── Icons ────────────────────────────────────────────────────────────────

/** The smallest valid PNG — 1x1, transparent. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

test('an icon file is uploaded and recorded on the app', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'haven-seed-'));
  const { client } = await freshHaven(t, { iconDir: join(dir, 'icons') });

  await writeFile(join(dir, 'example.png'), PNG_1X1);

  const result = await applySeed({
    client,
    baseDir: dir,
    doc: seedDoc({
      apps: [{ ...app1, iconFile: 'example.png' }],
      instances: [],
      layout: {},
    }),
  });

  assert.equal(result.ok, true);
  const icon = result.results.find((r) => r.kind === 'icon');
  assert.equal(icon.action, 'uploaded');

  const [app] = await client.listApps();
  assert.equal(app.icon, 'example-service.png');
});

test('a missing icon file is skipped, not failed', async (t) => {
  const { client } = await freshHaven(t);

  const result = await applySeed({
    client,
    baseDir: tmpdir(),
    doc: seedDoc({
      apps: [{ ...app1, iconFile: 'definitely-not-here.png' }],
      instances: [],
      layout: {},
    }),
  });

  assert.equal(result.ok, true, 'a missing icon must not fail the run');
  const icon = result.results.find((r) => r.kind === 'icon');
  assert.equal(icon.action, 'skipped');
  assert.match(icon.detail, /no file at/);
});

test('re-applying with an icon does not blank the stored icon filename', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'haven-seed-'));
  const { client } = await freshHaven(t, { iconDir: join(dir, 'icons') });
  await writeFile(join(dir, 'example.png'), PNG_1X1);

  const doc = seedDoc({
    apps: [{ ...app1, iconFile: 'example.png' }],
    instances: [],
    layout: {},
  });

  await applySeed({ client, baseDir: dir, doc });
  const second = await applySeed({ client, baseDir: dir, doc });

  assert.deepEqual(
    second.results.filter((r) => r.kind === 'app').map((r) => r.action),
    ['skipped'],
    'an app whose only pending work is its icon must not read as changed'
  );

  const [app] = await client.listApps();
  assert.equal(app.icon, 'example-service.png', 'the stored icon must survive a re-apply');
});

// ── Envelope validation ──────────────────────────────────────────────────

test('validateSeed rejects duplicates, unknown breakpoints and bad versions', () => {
  assert.throws(
    () =>
      validateSeed({
        apps: [
          { id: 'a', urls: [] },
          { id: 'a', urls: [] },
        ],
      }),
    /Duplicate app id "a"/
  );

  assert.throws(() => validateSeed({ layout: { tablet: [] } }), /Unknown breakpoint\(s\)/);

  assert.throws(() => validateSeed({ version: 99 }), /Unsupported seed version/);

  assert.throws(
    () => validateSeed({ instances: [{ id: 'x' }] }),
    /instances\[0\]\.type is required/
  );
});

test('an empty document is valid — every section is optional', () => {
  const { apps, instances, layout } = validateSeed({ version: 1 });
  assert.deepEqual(apps, []);
  assert.deepEqual(instances, []);
  assert.deepEqual(layout, {});
});

/**
 * Regression: instances whose `sortOrder` the file does not state.
 *
 * `create` assigns the next free slot, so a four-instance file ends up with
 * 0,1,2,3 on the server while the file states none of them. Comparing an
 * unstated sortOrder against a default of 0 made three of those four re-PUT
 * themselves on every run — converging on the right data, but rewriting the
 * roster forever and reporting "updated" when nothing had changed.
 */
test('instances with no stated sortOrder are skipped on re-apply, not rewritten', async (t) => {
  const { client } = await freshHaven(t);

  const doc = seedDoc({
    apps: [],
    layout: {},
    instances: [
      { id: 'first', type: 'clock', config: {} },
      { id: 'second', type: 'clock', config: {} },
      { id: 'third', type: 'clock', config: {} },
      { id: 'fourth', type: 'clock', config: {} },
    ],
  });

  await applySeed({ client, doc });
  const second = await applySeed({ client, doc });

  assert.deepEqual(
    second.results.map((r) => r.action),
    ['skipped', 'skipped', 'skipped', 'skipped'],
    'an unstated sortOrder means "wherever it already is", not position 0'
  );
});

/**
 * Regression: `$comment` is the convention every config/*.example.json here
 * uses to explain itself, and the seed file is the one most in need of it.
 * Left in the payload it reaches the API as an unexpected field and is
 * reported as an unmapped unknown — the file's own documentation showing up
 * as a warning about the file.
 */
test('$comment annotations are stripped and never reach the API', async (t) => {
  const { client } = await freshHaven(t);

  const result = await applySeed({
    client,
    doc: seedDoc({
      apps: [{ ...app1, $comment: 'why this app is here' }],
      instances: [{ id: 'clock-local', type: 'clock', config: {}, $comment: 'a note' }],
      layout: {},
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.migration.unknown, [], '$comment must not be reported as unmapped');

  const [app] = await client.listApps();
  assert.ok(!('$comment' in app), 'the annotation must not be stored');
});

/**
 * The shipped example must actually work. An example file that fails to apply
 * is worse than none: it is the first thing anyone runs, and it is what they
 * copy. This applies it twice — once to prove it lands, once to prove the
 * shipped file is genuinely idempotent rather than idempotent-in-theory.
 */
test('config/dashboard.example.json applies cleanly and is idempotent', async (t) => {
  const { client } = await freshHaven(t);

  const doc = JSON.parse(
    await readFile(new URL('../../config/dashboard.example.json', import.meta.url), 'utf8')
  );

  const first = await applySeed({ client, doc, baseDir: 'config' });
  assert.equal(first.ok, true, JSON.stringify(first.results.filter((r) => r.action === 'failed')));

  const second = await applySeed({ client, doc, baseDir: 'config' });
  assert.ok(
    second.results.every((r) => r.action === 'skipped'),
    `the shipped example must re-apply clean, got: ${JSON.stringify(
      second.results.filter((r) => r.action !== 'skipped')
    )}`
  );
});

/**
 * The secret test that actually bites.
 *
 * The round-trip test above is necessary but NOT sufficient, and it is worth
 * saying why in the file: an unchanged instance is judged `skipped`, so no PUT
 * is sent and no wipe *can* happen. It passes even against a build that would
 * wipe the credential — mutation testing showed exactly that.
 *
 * The hazard needs an UPDATE, which is the realistic case: export the
 * dashboard, rename a widget's title, re-apply. That fires a PUT carrying the
 * whole config, sentinel included, and everything the secret contract is for
 * has to hold on that one request.
 *
 * Two distinct ways it can go wrong, asserted separately:
 *   - the credential is wiped or replaced by the sentinel string
 *   - the sentinel is dropped from the config blob, orphaning a credential
 *     that still exists while the widget stops knowing a secret is set
 */
test('editing an unrelated field does not disturb a stored secret', async (t) => {
  const { client, credentials } = await freshHaven(t);

  await applySeed({
    client,
    doc: seedDoc({
      apps: [],
      layout: {},
      instances: [
        {
          id: 'private-feed',
          type: 'calendar',
          config: { title: 'Calendar', icsUrl: 'https://calendar.invalid/feed.ics' },
          secretKeys: ['icsUrl'],
        },
      ],
    }),
  });

  const name = secretName('private-feed', 'icsUrl');

  const exported = await exportSeed(client);
  assert.deepEqual(
    exported.instances[0].secretKeys,
    ['icsUrl'],
    'export must re-declare secretKeys, or a later update routes the key as an ordinary field'
  );

  // The realistic edit: change something else entirely.
  exported.instances[0].config.title = 'Renamed Calendar';

  const result = await applySeed({ client, doc: exported });
  assert.deepEqual(
    result.results.filter((r) => r.kind === 'instance').map((r) => r.action),
    ['updated'],
    'this test is only meaningful if it actually fires a PUT'
  );

  assert.equal(
    credentials.get(name),
    'https://calendar.invalid/feed.ics',
    'the stored credential must survive an unrelated edit'
  );

  const [live] = await client.listInstances();
  assert.equal(live.config.title, 'Renamed Calendar', 'the intended edit must land');
  assert.equal(
    live.config.icsUrl,
    SECRET_SET,
    'the sentinel must remain, or the widget stops knowing a secret is set'
  );
});
