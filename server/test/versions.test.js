import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/db/apps-store.js';
import { migrate } from '../src/db/migrate.js';
import { buildServer } from '../src/server.js';
import {
  LATEST_CACHE_MS,
  LATEST_ERROR_CACHE_MS,
  VersionCache,
  compareVersions,
  currentVersionSource,
  fetchLatest,
  resolveCurrent,
  toReleasesApiUrl,
} from '../src/routes/versions.js';

/**
 * Fixtures use `.invalid` hostnames and invented owner/repo names. Nothing
 * here comes from a real registry — see docs/SECURITY.md.
 */
const appFixture = (overrides = {}) => ({
  id: 'example-service',
  name: 'Example Service',
  description: 'What this service is for.',
  category: 'tools',
  icon: null,
  urls: [{ title: 'Open', url: 'https://example.invalid', primary: true }],
  version: {
    latestUrl: 'https://api.github.com/repos/exampleowner/examplerepo/releases/latest',
    currentContainerId: 'example-container',
  },
  sortOrder: 0,
  ...overrides,
});

function freshDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

function serverWith(db) {
  return buildServer({
    logger: false,
    db,
    seedPath: join(tmpdir(), 'haven-no-such-seed.json'),
    iconDir: mkdtempSync(join(tmpdir(), 'haven-icons-')),
  });
}

/** A `fetch` double that records its calls. */
function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return responder(url, options);
  };
  fn.calls = calls;
  return fn;
}

const releaseResponse = (body, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
});

describe('toReleasesApiUrl', () => {
  test('canonicalises an api.github.com releases URL', () => {
    assert.equal(
      toReleasesApiUrl('https://api.github.com/repos/owner/repo/releases/latest'),
      'https://api.github.com/repos/owner/repo/releases/latest'
    );
  });

  test('converts a human releases page to the API URL', () => {
    assert.equal(
      toReleasesApiUrl('https://github.com/owner/repo/releases'),
      'https://api.github.com/repos/owner/repo/releases/latest'
    );
  });

  test('accepts a bare repo page', () => {
    assert.equal(
      toReleasesApiUrl('https://github.com/owner/repo'),
      'https://api.github.com/repos/owner/repo/releases/latest'
    );
  });

  /**
   * The allow-list is the security boundary: `latestUrl` is user-editable, so
   * without it this route is a server-side request forgery primitive that
   * fetches arbitrary URLs from inside the LAN with a token attached.
   */
  test('rejects a non-GitHub host', () => {
    assert.equal(toReleasesApiUrl('https://evil.invalid/repos/owner/repo/releases/latest'), null);
  });

  test('rejects an internal address', () => {
    assert.equal(toReleasesApiUrl('http://router.internal.invalid/admin'), null);
  });

  test('rejects http even on an allowed host', () => {
    assert.equal(toReleasesApiUrl('http://api.github.com/repos/owner/repo/releases/latest'), null);
  });

  test('rejects a GitHub URL with no repo', () => {
    assert.equal(toReleasesApiUrl('https://github.com/owner'), null);
  });

  test('rejects an api.github.com path that is not /repos', () => {
    assert.equal(toReleasesApiUrl('https://api.github.com/users/owner'), null);
  });

  test('returns null for missing or unparseable input', () => {
    assert.equal(toReleasesApiUrl(undefined), null);
    assert.equal(toReleasesApiUrl(''), null);
    assert.equal(toReleasesApiUrl('not a url'), null);
  });
});

describe('compareVersions', () => {
  test('treats a leading v as noise', () => {
    assert.equal(compareVersions('v1.2.3', '1.2.3'), 'same');
    assert.equal(compareVersions('1.2.3', 'v1.2.3'), 'same');
  });

  test('reports a real difference', () => {
    assert.equal(compareVersions('1.2.3', '1.3.0'), 'differs');
  });

  test('is unknown when either side is missing', () => {
    assert.equal(compareVersions(null, '1.2.3'), 'unknown');
    assert.equal(compareVersions('1.2.3', null), 'unknown');
    assert.equal(compareVersions(null, null), 'unknown');
  });

  test('does not strip a v that is part of a word', () => {
    assert.equal(compareVersions('version-1', '1'), 'differs');
  });
});

describe('resolveCurrent', () => {
  test('reads the operator-supplied container map', () => {
    assert.equal(
      resolveCurrent('example-container', { versions: { 'example-container': '1.4.2' } }),
      '1.4.2'
    );
  });

  test('is null for an unknown container', () => {
    assert.equal(resolveCurrent('missing-container', { versions: { other: '1.0.0' } }), null);
  });

  test('is null when no container id is configured', () => {
    assert.equal(resolveCurrent(null, { versions: { a: '1' } }), null);
    assert.equal(resolveCurrent('   ', { versions: { a: '1' } }), null);
  });
});

describe('fetchLatest', () => {
  test('returns the tag name, published date and release URL', async () => {
    const fetchFn = fakeFetch(async () =>
      releaseResponse({
        tag_name: 'v2.1.0',
        name: 'August update',
        published_at: '2026-08-01T00:00:00Z',
        html_url: 'https://github.com/owner/repo/releases/tag/v2.1.0',
      })
    );

    const result = await fetchLatest('https://api.github.com/repos/owner/repo/releases/latest', {
      fetchFn,
      token: null,
    });

    assert.equal(result.version, 'v2.1.0');
    assert.equal(result.publishedAt, '2026-08-01T00:00:00Z');
    assert.equal(result.url, 'https://github.com/owner/repo/releases/tag/v2.1.0');
  });

  /**
   * The token must be attached on the server and nowhere else. If this stops
   * holding, the credential is either missing from the upstream call or —
   * worse — has moved somewhere it can reach the browser.
   */
  test('attaches the GitHub token as a bearer header', async () => {
    const fetchFn = fakeFetch(async () => releaseResponse({ tag_name: '1.0.0' }));

    await fetchLatest('https://api.github.com/repos/owner/repo/releases/latest', {
      fetchFn,
      token: 'test-token-value',
    });

    assert.equal(fetchFn.calls[0].options.headers.Authorization, 'Bearer test-token-value');
  });

  test('sends no Authorization header when there is no token', async () => {
    const fetchFn = fakeFetch(async () => releaseResponse({ tag_name: '1.0.0' }));

    await fetchLatest('https://api.github.com/repos/owner/repo/releases/latest', {
      fetchFn,
      token: null,
    });

    assert.equal(fetchFn.calls[0].options.headers.Authorization, undefined);
  });

  test('never returns the token to the caller', async () => {
    const fetchFn = fakeFetch(async () => releaseResponse({ tag_name: '1.0.0' }));

    const result = await fetchLatest('https://api.github.com/repos/owner/repo/releases/latest', {
      fetchFn,
      token: 'test-token-value',
    });

    assert.ok(!JSON.stringify(result).includes('test-token-value'));
  });

  test('a second call inside the ttl is served from cache without a fetch', async () => {
    const fetchFn = fakeFetch(async () => releaseResponse({ tag_name: '1.0.0' }));
    const cache = new VersionCache();
    const url = 'https://api.github.com/repos/owner/repo/releases/latest';

    const first = await fetchLatest(url, { fetchFn, cache, token: null });
    const second = await fetchLatest(url, { fetchFn, cache, token: null });

    assert.equal(fetchFn.calls.length, 1);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.version, '1.0.0');
  });

  test('refetches once the ttl has expired', async () => {
    const fetchFn = fakeFetch(async () => releaseResponse({ tag_name: '1.0.0' }));
    let clock = 0;
    const cache = new VersionCache({ now: () => clock });
    const url = 'https://api.github.com/repos/owner/repo/releases/latest';

    await fetchLatest(url, { fetchFn, cache, token: null });
    clock += LATEST_CACHE_MS + 1;
    await fetchLatest(url, { fetchFn, cache, token: null });

    assert.equal(fetchFn.calls.length, 2);
  });

  /**
   * Negative caching is what stops a renamed or private repo re-hitting a
   * shared, low rate limit on every refresh of every open browser.
   */
  test('caches a failure too, so a dead repo is not re-fetched every refresh', async () => {
    const fetchFn = fakeFetch(async () =>
      releaseResponse({ message: 'Not Found' }, { status: 404 })
    );
    const cache = new VersionCache();
    const url = 'https://api.github.com/repos/owner/gone/releases/latest';

    const first = await fetchLatest(url, { fetchFn, cache, token: null });
    await fetchLatest(url, { fetchFn, cache, token: null });

    assert.equal(fetchFn.calls.length, 1);
    assert.equal(first.version, null);
    assert.equal(first.error, 'http_404');
  });

  test('a cached failure expires on the shorter error ttl', async () => {
    const fetchFn = fakeFetch(async () => releaseResponse({}, { status: 404 }));
    let clock = 0;
    const cache = new VersionCache({ now: () => clock });
    const url = 'https://api.github.com/repos/owner/gone/releases/latest';

    await fetchLatest(url, { fetchFn, cache, token: null });
    clock += LATEST_ERROR_CACHE_MS + 1;
    await fetchLatest(url, { fetchFn, cache, token: null });

    assert.equal(fetchFn.calls.length, 2);
    // And the shorter ttl really is shorter than the success one, which is the
    // reason there are two constants at all.
    assert.ok(LATEST_ERROR_CACHE_MS < LATEST_CACHE_MS);
  });

  test('names a rate-limit refusal specifically', async () => {
    const fetchFn = fakeFetch(async () =>
      releaseResponse({}, { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
    );

    const result = await fetchLatest('https://api.github.com/repos/owner/repo/releases/latest', {
      fetchFn,
      token: null,
    });

    assert.equal(result.error, 'rate_limited');
  });

  test('a 403 that is not a rate limit is reported as an http error', async () => {
    const fetchFn = fakeFetch(async () =>
      releaseResponse({}, { status: 403, headers: { 'x-ratelimit-remaining': '57' } })
    );

    const result = await fetchLatest('https://api.github.com/repos/owner/repo/releases/latest', {
      fetchFn,
      token: null,
    });

    assert.equal(result.error, 'http_403');
  });

  test('a thrown transport error degrades quietly rather than propagating', async () => {
    const fetchFn = fakeFetch(async () => {
      throw new Error('socket hang up');
    });

    const result = await fetchLatest('https://api.github.com/repos/owner/repo/releases/latest', {
      fetchFn,
      token: null,
    });

    assert.equal(result.version, null);
    assert.equal(result.error, 'unreachable');
  });

  test('a release with no tag or name is reported as no_release', async () => {
    const fetchFn = fakeFetch(async () => releaseResponse({ body: 'notes only' }));

    const result = await fetchLatest('https://api.github.com/repos/owner/repo/releases/latest', {
      fetchFn,
      token: null,
    });

    assert.equal(result.version, null);
    assert.equal(result.error, 'no_release');
  });

  test('falls back to the release name when there is no tag', async () => {
    const fetchFn = fakeFetch(async () => releaseResponse({ name: '3.0.0' }));

    const result = await fetchLatest('https://api.github.com/repos/owner/repo/releases/latest', {
      fetchFn,
      token: null,
    });

    assert.equal(result.version, '3.0.0');
  });
});

describe('version routes', () => {
  let db;
  let app;

  before(async () => {
    db = freshDb();
    app = await serverWith(db);
  });

  after(async () => {
    await app.close();
    db.close();
  });

  test('404s for an unknown app', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/versions/no-such-app' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, 'NOT_FOUND');
  });

  /**
   * No network in this test: the fixture has no `latestUrl`, so nothing is
   * fetched and the route must still answer rather than erroring.
   */
  test('an app with no version info degrades quietly to nulls', async () => {
    createApp(db, appFixture({ id: 'no-version-app', version: null }));

    const response = await app.inject({ method: 'GET', url: '/api/versions/no-version-app' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      id: 'no-version-app',
      current: null,
      // Null rather than absent: there is no running version, so there is no
      // reading to date. A timestamp here would be dating nothing.
      currentAsOf: null,
      latest: null,
      latestUrl: null,
      publishedAt: null,
      status: 'unknown',
    });
  });

  test('an unsupported latestUrl host is not fetched and yields no latest version', async () => {
    createApp(
      db,
      appFixture({
        id: 'offsite-version-app',
        version: { latestUrl: 'https://releases.example.invalid/latest', currentContainerId: null },
      })
    );

    const response = await app.inject({ method: 'GET', url: '/api/versions/offsite-version-app' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().latest, null);
    assert.equal(response.json().status, 'unknown');
  });

  test('the batch route returns an entry per registered app', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/versions' });

    assert.equal(response.statusCode, 200);
    const { versions } = response.json();
    assert.ok(Object.hasOwn(versions, 'no-version-app'));
    assert.ok(Object.hasOwn(versions, 'offsite-version-app'));
    assert.equal(versions['no-version-app'].status, 'unknown');
  });
});

describe('the combined dashboard route', () => {
  let db;
  let app;

  before(async () => {
    db = freshDb();
    app = await serverWith(db);
    createApp(db, appFixture({ id: 'dash-a', category: 'media', version: null }));
    createApp(db, appFixture({ id: 'dash-b', category: 'tools', version: null }));
  });

  after(async () => {
    await app.close();
    db.close();
  });

  /**
   * The widget host's contract is ONE request descriptor per widget, so the
   * apps widget cannot fetch the registry and the version map separately. If
   * this route stops returning both, the widget silently loses its versions.
   */
  test('returns apps and versions in a single response', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/apps/dashboard' });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.apps.length, 2);
    assert.ok(Object.hasOwn(body, 'versions'));
    assert.ok(Object.hasOwn(body.versions, 'dash-a'));
  });

  test('filters by category', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/apps/dashboard?category=media' });

    const body = response.json();
    assert.equal(body.apps.length, 1);
    assert.equal(body.apps[0].id, 'dash-a');
  });

  test('versions=false skips the version work entirely', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/apps/dashboard?versions=false',
    });

    const body = response.json();
    assert.equal(body.apps.length, 2);
    // No reason to warm a cache nobody is reading.
    assert.deepEqual(body.versions, {});
  });

  test('an empty registry is an empty response rather than an error', async () => {
    const emptyDb = freshDb();
    const emptyApp = await serverWith(emptyDb);
    try {
      const response = await emptyApp.inject({ method: 'GET', url: '/api/apps/dashboard' });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { apps: [], versions: {} });
    } finally {
      await emptyApp.close();
      emptyDb.close();
    }
  });
});

/**
 * The container versions file as the source of the "current" column, driven
 * through the real routes.
 *
 * These use `app.inject()` rather than calling the resolver directly, because
 * the thing worth protecting is the response the widget actually receives.
 */
describe('the container versions file, end to end', () => {
  let fileDir;

  before(() => {
    fileDir = mkdtempSync(join(tmpdir(), 'haven-versions-route-'));
  });

  after(() => {
    rmSync(fileDir, { recursive: true, force: true });
  });

  const writeVersionsFile = (name, contents) => {
    const path = join(fileDir, name);
    writeFileSync(path, JSON.stringify(contents), 'utf8');
    return path;
  };

  /** A server whose versions file is the given path, which may not exist. */
  async function serverWithVersionsFile(db, containerVersionsPath) {
    return buildServer({
      logger: false,
      db,
      seedPath: join(tmpdir(), 'haven-no-such-seed.json'),
      iconDir: mkdtempSync(join(tmpdir(), 'haven-icons-')),
      containerVersionsPath,
    });
  }

  test('serves the running version and its age from the file', async () => {
    const db = freshDb();
    createApp(
      db,
      appFixture({
        id: 'file-app',
        version: { latestUrl: null, currentContainerId: 'example-container' },
      })
    );
    const path = writeVersionsFile('served.json', {
      generatedAt: '2026-08-30T09:00:00.000Z',
      versions: { 'example-container': '1.4.2' },
    });
    const app = await serverWithVersionsFile(db, path);

    try {
      const body = (await app.inject({ method: 'GET', url: '/api/versions/file-app' })).json();

      assert.equal(body.current, '1.4.2');
      // Without this the UI cannot tell a version read a minute ago from one
      // read last month, which is the failure mode of a dead refresher.
      assert.equal(body.currentAsOf, '2026-08-30T09:00:00.000Z');
    } finally {
      await app.close();
      db.close();
    }
  });

  test('a missing file leaves behaviour exactly as it was', async () => {
    // The ship-independently claim rests on this: with no file present, the
    // response is identical to the one this route gave before the file
    // existed.
    const db = freshDb();
    createApp(
      db,
      appFixture({
        id: 'no-file-app',
        version: { latestUrl: null, currentContainerId: 'example-container' },
      })
    );
    const app = await serverWithVersionsFile(db, join(fileDir, 'definitely-absent.json'));

    try {
      const body = (await app.inject({ method: 'GET', url: '/api/versions/no-file-app' })).json();

      assert.deepEqual(body, {
        id: 'no-file-app',
        current: null,
        currentAsOf: null,
        latest: null,
        latestUrl: null,
        publishedAt: null,
        status: 'unknown',
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  test('a malformed file degrades to no current version rather than erroring', async () => {
    const db = freshDb();
    createApp(
      db,
      appFixture({
        id: 'broken-file-app',
        version: { latestUrl: null, currentContainerId: 'example-container' },
      })
    );
    const path = join(fileDir, 'broken.json');
    writeFileSync(path, '{ this is not json', 'utf8');
    const app = await serverWithVersionsFile(db, path);

    try {
      const response = await app.inject({ method: 'GET', url: '/api/versions/broken-file-app' });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().current, null);
      assert.equal(response.json().currentAsOf, null);
    } finally {
      await app.close();
      db.close();
    }
  });

  test('the flat map shape works through the route too', async () => {
    // The old dashboard's version script already emits this shape, so it can
    // be pointed at the mount without a translation step.
    const db = freshDb();
    createApp(
      db,
      appFixture({
        id: 'flat-file-app',
        version: { latestUrl: null, currentContainerId: 'example-container' },
      })
    );
    const app = await serverWithVersionsFile(
      db,
      writeVersionsFile('flat-route.json', { 'example-container': '7.7.7' })
    );

    try {
      const body = (await app.inject({ method: 'GET', url: '/api/versions/flat-file-app' })).json();

      assert.equal(body.current, '7.7.7');
      // Dated from the file's mtime, so a bare map is still checkable for age.
      assert.ok(body.currentAsOf, 'a flat map should still be dated, from the mtime');
    } finally {
      await app.close();
      db.close();
    }
  });

  test('the batch and dashboard routes carry currentAsOf as well', async () => {
    const db = freshDb();
    createApp(
      db,
      appFixture({
        id: 'batch-file-app',
        version: { latestUrl: null, currentContainerId: 'example-container' },
      })
    );
    const app = await serverWithVersionsFile(
      db,
      writeVersionsFile('batch.json', {
        generatedAt: '2026-08-29T10:00:00.000Z',
        versions: { 'example-container': '2.2.2' },
      })
    );

    try {
      const batch = (await app.inject({ method: 'GET', url: '/api/versions' })).json();
      assert.equal(batch.versions['batch-file-app'].current, '2.2.2');
      assert.equal(batch.versions['batch-file-app'].currentAsOf, '2026-08-29T10:00:00.000Z');

      const dash = (await app.inject({ method: 'GET', url: '/api/apps/dashboard' })).json();
      assert.equal(dash.versions['batch-file-app'].currentAsOf, '2026-08-29T10:00:00.000Z');
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe('currentVersionSource — precedence', () => {
  const readerOf = (value) => ({ read: () => value });

  /**
   * The env map is injected rather than read from `config`, which is frozen at
   * import from the environment. Without injecting it these tests would run
   * against an EMPTY env map, and "file wins" would pass for either merge
   * order — a hollow test that proves nothing about precedence.
   */
  const envMap = { 'example-container': 'from-env', 'example-env-only': '0.0.1' };

  test('the file wins over the env map for the same container', () => {
    const source = currentVersionSource(
      readerOf({
        versions: { 'example-container': 'from-file' },
        generatedAt: '2026-08-30T00:00:00Z',
      }),
      { envVersions: envMap }
    );

    assert.equal(source.versions['example-container'], 'from-file');
    assert.equal(source.currentAsOf, '2026-08-30T00:00:00Z');
  });

  test('a container the file does not know about still resolves from the env map', () => {
    // Merged, not replaced: adopting the file must not make containers the
    // writer has never heard of vanish from the dashboard.
    const source = currentVersionSource(
      readerOf({ versions: { 'example-container': 'from-file' }, generatedAt: null }),
      { envVersions: envMap }
    );

    assert.equal(source.versions['example-env-only'], '0.0.1');
  });

  test('with no file the env map is used unchanged', () => {
    const source = currentVersionSource(readerOf({ versions: {}, generatedAt: null }), {
      envVersions: envMap,
    });

    assert.deepEqual(source.versions, envMap);
  });

  test('with no file there is no timestamp to report', () => {
    // The env map's age is whenever someone last edited it, which nothing here
    // knows. Reporting "now" would claim a freshness that does not exist.
    const source = currentVersionSource(readerOf({ versions: {}, generatedAt: null }), {
      envVersions: envMap,
    });

    assert.equal(source.currentAsOf, null);
  });

  test('tolerates a missing reader entirely', () => {
    assert.equal(currentVersionSource(undefined).currentAsOf, null);
  });
});
