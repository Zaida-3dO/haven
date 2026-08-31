import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { migrate } from '../src/db/migrate.js';
import { buildServer } from '../src/server.js';

/**
 * Fixtures are built from the shape in `config/apps.example.json` and use
 * `.invalid` hostnames throughout. Nothing here comes from a real registry —
 * see docs/SECURITY.md.
 */
const exampleApp = (overrides = {}) => ({
  id: 'example-service',
  name: 'Example Service',
  description: 'What this service is for.',
  category: 'tools',
  icon: 'example.svg',
  urls: [
    { title: 'Open Local', url: 'https://example.local.invalid' },
    { title: 'Open', url: 'https://example.invalid', primary: true },
    { title: 'Open via Tailscale', url: 'https://example.ts.invalid' },
  ],
  version: {
    latestUrl: 'https://api.github.com/repos/example/example/releases/latest',
    currentContainerId: 'example-container',
  },
  ...overrides,
});

function freshDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

/** A server on an in-memory db with seeding disabled (no seed file present). */
async function serverWith(db, opts = {}) {
  return buildServer({
    logger: false,
    db,
    seedPath: join(tmpdir(), 'haven-no-such-seed.json'),
    iconDir: mkdtempSync(join(tmpdir(), 'haven-icons-')),
    ...opts,
  });
}

describe('app registry API', () => {
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

  test('starts empty, then round-trips a created app', async () => {
    const empty = await app.inject({ method: 'GET', url: '/api/apps' });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json().apps, []);

    const created = await app.inject({ method: 'POST', url: '/api/apps', payload: exampleApp() });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().id, 'example-service');
    assert.equal(created.json().visitCount, 0);

    const fetched = await app.inject({ method: 'GET', url: '/api/apps/example-service' });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.json().name, 'Example Service');
    assert.equal(fetched.json().version.currentContainerId, 'example-container');
  });

  test('preserves url ORDER exactly — the order is probe priority', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/apps/example-service' });
    // If storage ever reorders (e.g. sorting primary-first), reachability
    // would probe a different host first and clicks would land elsewhere.
    assert.deepEqual(
      res.json().urls.map((u) => u.url),
      ['https://example.local.invalid', 'https://example.invalid', 'https://example.ts.invalid']
    );
    assert.equal(res.json().urls[1].primary, true);
  });

  test('rejects a duplicate id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/apps', payload: exampleApp() });
    assert.equal(res.statusCode, 409);
  });

  test('updates an app without letting the body rename it', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/apps/example-service',
      payload: exampleApp({ id: 'attacker-chosen-id', name: 'Renamed' }),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().id, 'example-service');
    assert.equal(res.json().name, 'Renamed');

    const ghost = await app.inject({ method: 'GET', url: '/api/apps/attacker-chosen-id' });
    assert.equal(ghost.statusCode, 404);
  });

  test('counts visits server-side and refuses a client-set count', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/apps/example-service/visit' });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().visitCount, 1);

    const second = await app.inject({ method: 'POST', url: '/api/apps/example-service/visit' });
    assert.equal(second.json().visitCount, 2);

    const spoof = await app.inject({
      method: 'PUT',
      url: '/api/apps/example-service',
      payload: exampleApp({ visitCount: 9999 }),
    });
    assert.equal(spoof.statusCode, 400);
    assert.match(spoof.json().details.join(' '), /server-managed/);

    const after = await app.inject({ method: 'GET', url: '/api/apps/example-service' });
    assert.equal(after.json().visitCount, 2);
  });

  test('deletes, and 404s afterwards', async () => {
    const gone = await app.inject({ method: 'DELETE', url: '/api/apps/example-service' });
    assert.equal(gone.statusCode, 204);

    const missing = await app.inject({ method: 'GET', url: '/api/apps/example-service' });
    assert.equal(missing.statusCode, 404);

    const again = await app.inject({ method: 'DELETE', url: '/api/apps/example-service' });
    assert.equal(again.statusCode, 404);
  });
});

describe('app registry validation', () => {
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

  const rejects = async (payload, pattern) => {
    const res = await app.inject({ method: 'POST', url: '/api/apps', payload });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload).slice(0, 80)}`);
    assert.match(res.json().details.join(' '), pattern);
  };

  test('requires exactly one primary url', async () => {
    await rejects(
      exampleApp({
        id: 'no-primary',
        urls: [{ title: 'Open', url: 'https://a.invalid' }],
      }),
      /exactly one url must be marked primary \(found 0\)/
    );

    await rejects(
      exampleApp({
        id: 'two-primaries',
        urls: [
          { title: 'A', url: 'https://a.invalid', primary: true },
          { title: 'B', url: 'https://b.invalid', primary: true },
        ],
      }),
      /exactly one url must be marked primary \(found 2\)/
    );
  });

  test('requires a non-empty urls array', async () => {
    await rejects(exampleApp({ id: 'no-urls', urls: [] }), /non-empty array/);
  });

  test('rejects a javascript: url', async () => {
    await rejects(
      exampleApp({
        id: 'xss',
        // eslint-disable-next-line no-script-url
        urls: [{ title: 'Open', url: 'javascript:alert(1)', primary: true }],
      }),
      /must be http or https/
    );
  });

  test('rejects an unknown category', async () => {
    await rejects(exampleApp({ id: 'bad-cat', category: 'nonsense' }), /category must be one of/);
  });

  test('rejects a bad id', async () => {
    await rejects(exampleApp({ id: 'Not Valid!' }), /id must be lowercase/);
  });

  test('rejects an icon containing a path', async () => {
    await rejects(exampleApp({ id: 'traversal', icon: '../../etc/passwd' }), /bare filename/);
  });
});

describe('seeding from config/apps.json', () => {
  const writeSeed = (apps) => {
    const dir = mkdtempSync(join(tmpdir(), 'haven-seed-'));
    const path = join(dir, 'apps.json');
    writeFileSync(path, JSON.stringify({ version: 1, apps }));
    return path;
  };

  test('seeds when the table is empty', async () => {
    const db = freshDb();
    const app = await buildServer({
      logger: false,
      db,
      seedPath: writeSeed([exampleApp()]),
      iconDir: mkdtempSync(join(tmpdir(), 'haven-icons-')),
    });

    const res = await app.inject({ method: 'GET', url: '/api/apps' });
    assert.equal(res.json().apps.length, 1);
    assert.equal(res.json().apps[0].id, 'example-service');

    await app.close();
    db.close();
  });

  test('does NOT re-seed over an existing registry — the db is the source of truth', async () => {
    const db = freshDb();
    const seedPath = writeSeed([exampleApp()]);

    const first = await buildServer({
      logger: false,
      db,
      seedPath,
      iconDir: mkdtempSync(join(tmpdir(), 'haven-icons-')),
    });
    await first.inject({
      method: 'PUT',
      url: '/api/apps/example-service',
      payload: exampleApp({ name: 'Renamed In UI' }),
    });
    await first.close();

    // Restart against the same db and the same, unchanged, seed file.
    const second = await buildServer({
      logger: false,
      db,
      seedPath,
      iconDir: mkdtempSync(join(tmpdir(), 'haven-icons-')),
    });
    const res = await second.inject({ method: 'GET', url: '/api/apps/example-service' });

    // A re-seed here would silently revert the rename on every restart.
    assert.equal(res.json().name, 'Renamed In UI');
    assert.equal((await second.inject({ method: 'GET', url: '/api/apps' })).json().apps.length, 1);

    await second.close();
    db.close();
  });

  test('a missing seed file is not an error', async () => {
    const db = freshDb();
    const app = await serverWith(db);

    const res = await app.inject({ method: 'GET', url: '/api/apps' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().apps, []);

    await app.close();
    db.close();
  });

  test('the shipped example config is itself a valid seed', async () => {
    // Guards against the example drifting out of sync with the validator.
    const example = JSON.parse(readFileSync(new URL('../../config/apps.example.json', import.meta.url), 'utf8'));
    const db = freshDb();
    const seedDir = mkdtempSync(join(tmpdir(), 'haven-seed-'));
    const seedPath = join(seedDir, 'apps.json');
    writeFileSync(seedPath, JSON.stringify(example));

    const app = await buildServer({
      logger: false,
      db,
      seedPath,
      iconDir: mkdtempSync(join(tmpdir(), 'haven-icons-')),
    });

    const res = await app.inject({ method: 'GET', url: '/api/apps' });
    assert.equal(res.json().apps.length, example.apps.length);

    await app.close();
    db.close();
  });
});
