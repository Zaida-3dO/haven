import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildServer } from '../src/server.js';

test('GET /api/health reports ok', async (t) => {
  const app = await buildServer({ logger: false });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/health' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
});
