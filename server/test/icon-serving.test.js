import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { migrate } from '../src/db/migrate.js';
import { buildServer } from '../src/server.js';

/**
 * Uploading an icon and then FETCHING IT BACK.
 *
 * This exists because nothing did it. Icons were uploaded in tests and never
 * requested, so the static route that serves them was exercised for the first
 * time by a real browser — and it crashed the process on every icon request:
 *
 *   TypeError: reply.setHeader is not a function
 *       at setHeaders (routes/apps.js)
 *       at pumpSendToReply (@fastify/static)
 *
 * `@fastify/static` calls `setHeaders` with the RAW Node ServerResponse, not a
 * Fastify reply. The callback had been written against a parameter named
 * `reply`, and a Fastify-only method there throws inside the send pump and
 * takes the whole server down with it.
 *
 * The lesson generalises past this one bug: a write path that is never read
 * back is only half-tested, and security headers in particular are invisible
 * until something actually asks for the file.
 */

// A one-pixel PNG, built here rather than committed — the smallest real image
// that exercises the MIME allow-list honestly.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function multipart(buffer, filename, contentType) {
  const boundary = '----havenTestBoundary';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, buffer, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function appWith(t) {
  const db = new Database(':memory:');
  migrate(db);
  const iconDir = mkdtempSync(join(tmpdir(), 'haven-icons-'));
  const app = await buildServer({ logger: false, db, iconDir });
  t.after(async () => {
    await app.close();
    db.close();
  });

  await app.inject({
    method: 'POST',
    url: '/api/apps',
    payload: {
      id: 'example-service',
      name: 'Example Service',
      category: 'tools',
      urls: [{ title: 'Open', url: 'https://example.invalid', primary: true }],
    },
  });

  return app;
}

async function uploadIcon(app, buffer = PNG_1PX, name = 'icon.png', type = 'image/png') {
  const { body, headers } = multipart(buffer, name, type);
  return app.inject({
    method: 'POST',
    url: '/api/apps/example-service/icon',
    payload: body,
    headers,
  });
}

test('an uploaded icon can be fetched back', async (t) => {
  const app = await appWith(t);

  const upload = await uploadIcon(app);
  assert.equal(upload.statusCode, 200, 'upload should succeed');

  const res = await app.inject({ method: 'GET', url: `/api/apps/icons/${upload.json().icon}` });

  // Before the fix this threw inside @fastify/static rather than answering.
  assert.equal(res.statusCode, 200);
  assert.equal(res.rawPayload.length, PNG_1PX.length);
});

test('a served icon carries its hardening headers', async (t) => {
  const app = await appWith(t);
  const upload = await uploadIcon(app);

  const res = await app.inject({ method: 'GET', url: `/api/apps/icons/${upload.json().icon}` });

  // Defence in depth behind the type allow-list: an uploaded file is served
  // from the origin that holds every /api route, so it must not be sniffed
  // into something executable, and must be able to load nothing.
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.headers['content-security-policy'] ?? '', /default-src 'none'/);
});

test('serving an icon does not kill the server — the next request still works', async (t) => {
  const app = await appWith(t);
  const upload = await uploadIcon(app);

  await app.inject({ method: 'GET', url: `/api/apps/icons/${upload.json().icon}` });

  // The real symptom was a process-level crash, so the assertion that matters
  // is that the server is still answering afterwards.
  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).json().status, 'ok');
});

test('SVG is refused — an inline-served SVG on this origin is stored XSS', async (t) => {
  const app = await appWith(t);

  const res = await uploadIcon(
    app,
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    'evil.svg',
    'image/svg+xml'
  );

  assert.equal(res.statusCode, 415);
});
