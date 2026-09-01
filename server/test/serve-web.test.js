import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrate.js';
import { buildServer } from '../src/server.js';

/**
 * The shell has to actually be served.
 *
 * This exists because it was not. The Dockerfile copied `web/dist` into the
 * image and nothing ever served it, so `/` answered 404 while every /api route
 * worked — a container with no UI at all. Every test drove `app.inject()`
 * against the API and the health check only asked for `/api/health`, so
 * nothing noticed until a browser opened the page.
 */

function webDirWith(html = '<!doctype html><title>Haven</title>') {
  const dir = mkdtempSync(join(tmpdir(), 'haven-web-'));
  writeFileSync(join(dir, 'index.html'), html);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'export default 1;\n');
  return dir;
}

async function appWith(t, webDir) {
  const db = new Database(':memory:');
  migrate(db);
  const app = await buildServer({ logger: false, db, webDir });
  t.after(async () => {
    await app.close();
    db.close();
  });
  return app;
}

test('GET / serves the built shell', async (t) => {
  const app = await appWith(t, webDirWith());

  const res = await app.inject({ method: 'GET', url: '/' });

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<title>Haven<\/title>/);
});

test('a built asset is served', async (t) => {
  const app = await appWith(t, webDirWith());

  assert.equal((await app.inject({ method: 'GET', url: '/assets/app.js' })).statusCode, 200);
});

test('an unknown non-API path falls back to the shell, not a 404', async (t) => {
  const app = await appWith(t, webDirWith());

  const res = await app.inject({ method: 'GET', url: '/some/deep/link' });

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<title>Haven<\/title>/);
});

test('an unknown API path still 404s as JSON — the shell must not shadow it', async (t) => {
  const app = await appWith(t, webDirWith());

  const res = await app.inject({ method: 'GET', url: '/api/definitely-not-a-route' });

  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'NOT_FOUND');
});

test('the API still answers with the shell mounted', async (t) => {
  const app = await appWith(t, webDirWith());

  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).json().status, 'ok');
});

test('a missing web directory is a warning, not a crash', async (t) => {
  // Running the API without having built the shell is a legitimate dev state.
  const app = await appWith(t, join(tmpdir(), 'haven-web-does-not-exist'));

  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).json().status, 'ok');
});
