import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';
import { createApp, listFeaturedApps } from '../src/db/apps-store.js';
import { migrate } from '../src/db/migrate.js';
import { validateApp } from '../src/routes/apps-schema.js';
import { buildServer } from '../src/server.js';

/**
 * Fixtures use `.invalid` hostnames and invented names throughout. Nothing here
 * comes from a real registry — see docs/SECURITY.md.
 */
const exampleApp = (overrides = {}) => ({
  id: 'example-service',
  name: 'Example Service',
  description: 'What this service is for.',
  category: 'tools',
  urls: [
    { title: 'Open Local', url: 'https://example.local.invalid' },
    { title: 'Open', url: 'https://example.invalid', primary: true },
  ],
  ...overrides,
});

function freshDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

async function serverWith(db) {
  return buildServer({
    logger: false,
    db,
    seedPath: join(tmpdir(), 'haven-no-such-seed.json'),
    iconDir: join(tmpdir(), 'haven-test-icons'),
  });
}

/** Inserts an app through the validator, as the route would. */
function insert(db, overrides) {
  const result = validateApp(exampleApp(overrides));
  assert.ok(result.valid, `fixture is invalid: ${result.errors.join(', ')}`);
  return createApp(db, result.value);
}

describe('the featured block', () => {
  test('round-trips through the database', () => {
    // The whole point of migration 002: before it, `featured` had nowhere to
    // live and was silently dropped on the way in.
    const db = freshDb();
    const app = insert(db, { featured: { tagline: 'Track what you spend', cover: 'a.jpg' } });

    assert.deepEqual(app.featured, { tagline: 'Track what you spend', cover: 'a.jpg' });
    db.close();
  });

  test('an app with no featured block reads back as null, not undefined', () => {
    const db = freshDb();
    assert.equal(insert(db, {}).featured, null);
    db.close();
  });

  test('a corrupt featured blob degrades to null rather than throwing', () => {
    // One bad row must not take down the whole registry listing — the same
    // tolerance `urls` and `version_info` already get.
    const db = freshDb();
    insert(db, { featured: { tagline: 'Fine' } });
    db.prepare('UPDATE apps SET featured = ?').run('{not json');

    assert.doesNotThrow(() => listFeaturedApps(db));
    assert.deepEqual(listFeaturedApps(db), [], 'the unrenderable row is dropped');
    db.close();
  });

  test('a tagline is required when a featured block is present', () => {
    const result = validateApp(exampleApp({ featured: { cover: 'a.jpg' } }));
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /featured\.tagline is required/);
  });

  test('an over-long tagline is refused — a hero line, not a paragraph', () => {
    const result = validateApp(exampleApp({ featured: { tagline: 'x'.repeat(141) } }));
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /140 characters/);
  });

  test('a cover carrying a path is refused', () => {
    // The cover is a bare filename joined against the data volume, so a
    // separator here is a path traversal waiting for somewhere to be joined.
    for (const cover of ['../../etc/passwd', 'a/b.jpg', String.raw`a\b.jpg`]) {
      const result = validateApp(exampleApp({ featured: { tagline: 'ok', cover } }));
      assert.equal(result.valid, false, `${cover} should be refused`);
      assert.match(result.errors.join(' '), /bare filename/);
    }
  });

  test('a non-object featured block is refused rather than coerced', () => {
    const result = validateApp(exampleApp({ featured: 'yes please' }));
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /featured must be an object/);
  });
});

describe('listFeaturedApps', () => {
  test('returns only the apps that carry a featured block', () => {
    const db = freshDb();
    insert(db, { id: 'plain' });
    insert(db, { id: 'shiny', featured: { tagline: 'Shiny' } });

    assert.deepEqual(
      listFeaturedApps(db).map((a) => a.id),
      ['shiny']
    );
    db.close();
  });

  test('orders by sortOrder, NOT by visit count', () => {
    // Deliberately different from `listApps`. A hero that reorders itself as
    // you click through it is disorienting, and the point of featuring
    // something is that you chose its placement.
    const db = freshDb();
    insert(db, { id: 'second', sortOrder: 2, featured: { tagline: 'B' } });
    insert(db, { id: 'first', sortOrder: 1, featured: { tagline: 'A' } });
    db.prepare("UPDATE apps SET visit_count = 500 WHERE id = 'second'").run();

    assert.deepEqual(
      listFeaturedApps(db).map((a) => a.id),
      ['first', 'second'],
      'a heavily-visited app must not jump the queue'
    );
    db.close();
  });
});

describe('GET /api/widgets/hero', () => {
  test('returns a slide per featured app', async () => {
    const db = freshDb();
    insert(db, {
      id: 'ledger',
      name: 'Ledger',
      featured: { tagline: 'Track what you spend', cover: 'hero-ledger.jpg' },
    });
    const app = await serverWith(db);

    const response = await app.inject({ method: 'GET', url: '/api/widgets/hero' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().slides, [
      {
        id: 'ledger',
        type: 'app',
        title: 'Ledger',
        tagline: 'Track what you spend',
        cover: 'hero-ledger.jpg',
        url: 'https://example.invalid',
      },
    ]);

    await app.close();
    db.close();
  });

  test('the slide links to the PRIMARY url, not merely the first', () => {
    // `urls` is ordered by probe priority, and the primary deliberately rides
    // wherever `url` landed in that order rather than always leading.
    const db = freshDb();
    insert(db, { id: 'ledger', featured: { tagline: 'x' } });

    return serverWith(db).then(async (app) => {
      const { slides } = (await app.inject({ url: '/api/widgets/hero' })).json();
      assert.equal(slides[0].url, 'https://example.invalid');
      await app.close();
      db.close();
    });
  });

  test('does NOT leak the full url list — that is a map of the network', async () => {
    const db = freshDb();
    insert(db, { id: 'ledger', featured: { tagline: 'x' } });
    const app = await serverWith(db);

    const body = (await app.inject({ url: '/api/widgets/hero' })).body;

    assert.ok(!body.includes('example.local.invalid'), 'secondary URLs must not reach the browser');
    assert.equal((await app.inject({ url: '/api/widgets/hero' })).json().slides[0].urls, undefined);

    await app.close();
    db.close();
  });

  test('an empty registry is an empty slide list, not an error', async () => {
    const db = freshDb();
    const app = await serverWith(db);

    const response = await app.inject({ url: '/api/widgets/hero' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().slides, []);

    await app.close();
    db.close();
  });

  test('is never cached — featuring something is an editorial act', async () => {
    const db = freshDb();
    const app = await serverWith(db);

    const response = await app.inject({ url: '/api/widgets/hero' });
    assert.equal(response.headers['cache-control'], 'no-store');

    await app.close();
    db.close();
  });
});

describe('POST /api/apps/:id/cover', () => {
  /** A multipart body, built by hand so no fixture image is committed. */
  function multipart(bytes, { filename = 'cover.png', type = 'image/png' } = {}) {
    const boundary = '----havenTestBoundary';
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${type}\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return {
      payload: Buffer.concat([head, bytes, tail]),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  }

  test('stores the cover under a hero- prefix derived from the app id', async () => {
    // Derived from the id, never from the uploaded filename — a client-supplied
    // name is a path traversal waiting to happen.
    const db = freshDb();
    insert(db, { id: 'ledger', featured: { tagline: 'x' } });
    const app = await serverWith(db);

    const response = await app.inject({
      method: 'POST',
      url: '/api/apps/ledger/cover',
      ...multipart(Buffer.alloc(64, 1), { filename: '../../evil.png' }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().cover, 'hero-ledger.png');

    await app.close();
    db.close();
  });

  test('refuses a type outside the allow-list, including SVG', async () => {
    // Icons allow SVG; a cover does not. An SVG is a document that can carry
    // script, and a cover renders full-bleed behind content.
    const db = freshDb();
    insert(db, { id: 'ledger', featured: { tagline: 'x' } });
    const app = await serverWith(db);

    const response = await app.inject({
      method: 'POST',
      url: '/api/apps/ledger/cover',
      ...multipart(Buffer.from('<svg/>'), { filename: 'a.svg', type: 'image/svg+xml' }),
    });

    assert.equal(response.statusCode, 415);

    await app.close();
    db.close();
  });

  test('refuses an app with no featured block to attach it to', async () => {
    const db = freshDb();
    insert(db, { id: 'plain' });
    const app = await serverWith(db);

    const response = await app.inject({
      method: 'POST',
      url: '/api/apps/plain/cover',
      ...multipart(Buffer.alloc(16, 1)),
    });

    assert.equal(response.statusCode, 409);

    await app.close();
    db.close();
  });

  test('404s for an unknown app', async () => {
    const db = freshDb();
    const app = await serverWith(db);

    const response = await app.inject({
      method: 'POST',
      url: '/api/apps/nope/cover',
      ...multipart(Buffer.alloc(16, 1)),
    });

    assert.equal(response.statusCode, 404);

    await app.close();
    db.close();
  });
});

describe('the icon cap survives the larger cover cap', () => {
  test('an icon over 512KB is still refused, though multipart now allows 4MB', async () => {
    // The regression this guards: raising the shared multipart `fileSize` to
    // fit covers means `truncated` no longer fires at 512KB, so relying on it
    // alone would have silently raised the icon cap eightfold with no visible
    // symptom. Each route counts its own bytes instead.
    const db = freshDb();
    insert(db, { id: 'ledger' });
    const app = await serverWith(db);

    const boundary = '----havenTestBoundary';
    const head = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="big.png"\r\n' +
        'Content-Type: image/png\r\n\r\n'
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const oversize = Buffer.alloc(700 * 1024, 7);

    const response = await app.inject({
      method: 'POST',
      url: '/api/apps/ledger/icon',
      payload: Buffer.concat([head, oversize, tail]),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });

    assert.equal(response.statusCode, 413, 'the icon cap must not have drifted to the cover cap');

    await app.close();
    db.close();
  });
});
