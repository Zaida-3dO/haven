import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { migrate } from '../src/db/migrate.js';
import { buildServer } from '../src/server.js';

/** A server on a private in-memory DB, torn down with the test. */
async function freshApp(t) {
  const db = new Database(':memory:');
  migrate(db);

  const app = await buildServer({ logger: false, db });
  t.after(async () => {
    await app.close();
    db.close();
  });

  return { app, db };
}

/**
 * `payload` with a raw string would be sent without a JSON content-type and
 * bounce at 415 before the handler runs, so the body is serialised here and
 * the header set explicitly. That keeps the malformed-input cases testing
 * Haven's validator rather than Fastify's content-type negotiation.
 */
const put = (app, body) =>
  app.inject({
    method: 'PUT',
    url: '/api/layout',
    payload: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
const get = (app) => app.inject({ method: 'GET', url: '/api/layout' });

const node = (id, over = {}) => ({ id, x: 0, y: 0, w: 4, h: 2, ...over });

test('GET /api/layout on a fresh install returns empty breakpoints', async (t) => {
  const { app } = await freshApp(t);

  const res = await get(app);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().layout, { desktop: [], mobile: [] });
});

test('layout round-trips per breakpoint', async (t) => {
  const { app } = await freshApp(t);

  const desktop = [
    node('weather', { x: 0, y: 0, w: 4, h: 3 }),
    node('apps', { x: 4, y: 0, w: 8, h: 6 }),
  ];
  const mobile = [
    node('apps', { x: 0, y: 0, w: 4, h: 8 }),
    node('weather', { x: 0, y: 8, w: 4, h: 3 }),
  ];

  const saved = await put(app, { desktop, mobile });
  assert.equal(saved.statusCode, 200);

  const { layout } = (await get(app)).json();
  assert.deepEqual(layout.desktop, desktop);
  assert.deepEqual(layout.mobile, mobile);
});

test('mobile is stored explicitly, not derived from desktop', async (t) => {
  const { app, db } = await freshApp(t);

  // Deliberately contradictory: same widgets, different order and geometry.
  const desktop = [node('a', { x: 0, y: 0, w: 6, h: 2 }), node('b', { x: 6, y: 0, w: 6, h: 2 })];
  const mobile = [node('b', { x: 0, y: 0, w: 4, h: 5 }), node('a', { x: 0, y: 5, w: 4, h: 1 })];

  await put(app, { desktop, mobile });

  const { layout } = (await get(app)).json();
  assert.deepEqual(layout.mobile, mobile, 'mobile must come back exactly as sent');
  assert.notDeepEqual(layout.mobile, layout.desktop);

  // Two separate rows, per DESIGN §3 — not one row reflowed on read.
  const rows = db.prepare('SELECT breakpoint FROM layout ORDER BY breakpoint').all();
  assert.deepEqual(
    rows.map((r) => r.breakpoint),
    ['desktop', 'mobile']
  );
});

test('saving one breakpoint leaves the other untouched', async (t) => {
  const { app } = await freshApp(t);

  const desktop = [node('a', { w: 6, h: 4 })];
  await put(app, { desktop });

  const res = await put(app, { mobile: [node('a', { w: 4, h: 9 })] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().saved, ['mobile']);

  const { layout } = (await get(app)).json();
  assert.deepEqual(layout.desktop, desktop, 'desktop must survive a mobile-only save');
  assert.equal(layout.mobile[0].h, 9);
});

test('a re-save replaces rather than appends', async (t) => {
  const { app } = await freshApp(t);

  await put(app, { desktop: [node('a'), node('b', { x: 4 })] });
  await put(app, { desktop: [node('a', { w: 12, h: 5 })] });

  const { layout } = (await get(app)).json();
  assert.equal(layout.desktop.length, 1);
  assert.equal(layout.desktop[0].w, 12);
});

// ── rejection of malformed input ─────────────────────────────────────────
// Each case asserts nothing was stored, because "rejected with a 400 but
// written anyway" is the failure that matters.
const malformed = [
  ['a JSON string body', 'not-a-layout'],
  ['a JSON array body', [{ id: 'a' }]],
  ['a null body', null],
  ['an empty object', {}],
  ['an unknown breakpoint', { tablet: [] }],
  ['a breakpoint that is not an array', { desktop: { id: 'a' } }],
  ['a node that is not an object', { desktop: ['a'] }],
  ['a node with no id', { desktop: [{ x: 0, y: 0, w: 1, h: 1 }] }],
  ['a node with an empty id', { desktop: [node('  ')] }],
  ['a node with a non-integer x', { desktop: [node('a', { x: 1.5 })] }],
  ['a node with a negative y', { desktop: [node('a', { y: -1 })] }],
  ['a node with zero width', { desktop: [node('a', { w: 0 })] }],
  ['a node with a string height', { desktop: [node('a', { h: '3' })] }],
  ['a node with a missing height', { desktop: [{ id: 'a', x: 0, y: 0, w: 1 }] }],
  ['duplicate node ids', { desktop: [node('a'), node('a', { y: 4 })] }],
];

for (const [description, payload] of malformed) {
  test(`PUT /api/layout rejects ${description}`, async (t) => {
    const { app, db } = await freshApp(t);

    const res = await put(app, payload);

    assert.equal(res.statusCode, 400, `expected 400 for ${description}`);
    assert.equal(res.json().error, 'INVALID_LAYOUT');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM layout').get().n,
      0,
      'a rejected layout must not be stored'
    );
  });
}

test('a rejected save does not clobber an existing layout', async (t) => {
  const { app } = await freshApp(t);

  const good = [node('a', { w: 6, h: 3 })];
  await put(app, { desktop: good });

  const res = await put(app, { desktop: [node('a', { w: -1 })] });
  assert.equal(res.statusCode, 400);

  assert.deepEqual((await get(app)).json().layout.desktop, good);
});

test('unknown node fields are dropped rather than stored', async (t) => {
  const { app } = await freshApp(t);

  await put(app, {
    desktop: [{ ...node('a'), evil: '<script>', content: 'arbitrary' }],
  });

  const stored = (await get(app)).json().layout.desktop[0];
  assert.deepEqual(Object.keys(stored).sort(), ['h', 'id', 'w', 'x', 'y']);
});

test('an optional widgetId is preserved', async (t) => {
  const { app } = await freshApp(t);

  await put(app, { desktop: [node('a', { widgetId: 'weather-1' })] });

  assert.equal((await get(app)).json().layout.desktop[0].widgetId, 'weather-1');
});
