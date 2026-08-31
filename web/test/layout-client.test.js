import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { createLayoutClient, normaliseNodes } from '../src/shell/layout-client.js';

/** A fetch double recording the calls the client makes. */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];

  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const next = queue.shift() ?? { ok: true, body: {} };
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.body,
    };
  };

  fetchImpl.calls = calls;
  return fetchImpl;
}

describe('normaliseNodes', () => {
  test('fills in coordinates GridStack leaves undefined', () => {
    // An auto-positioned widget legitimately has no x/y, and the server
    // rejects a node whose coordinates are not integers.
    assert.deepEqual(normaliseNodes([{ id: 'a', w: 2, h: 2 }]), [
      { id: 'a', x: 0, y: 0, w: 2, h: 2 },
    ]);
  });

  test('drops fields the server does not store', () => {
    const [node] = normaliseNodes([
      { id: 'a', x: 0, y: 0, w: 1, h: 1, content: '<script>', _dirty: true },
    ]);

    assert.deepEqual(Object.keys(node).sort(), ['h', 'id', 'w', 'x', 'y']);
  });

  test('keeps widgetId when present', () => {
    const [node] = normaliseNodes([{ id: 'a', x: 0, y: 0, w: 1, h: 1, widgetId: 'clock-1' }]);
    assert.equal(node.widgetId, 'clock-1');
  });
});

describe('load', () => {
  test('returns both breakpoints', async () => {
    const fetchImpl = fakeFetch([
      {
        body: {
          layout: { desktop: [{ id: 'a', x: 0, y: 0, w: 2, h: 2 }], mobile: [] },
          updatedAt: { desktop: '2026-08-31', mobile: null },
        },
      },
    ]);

    const { layout } = await createLayoutClient({ fetchImpl }).load();

    assert.equal(layout.desktop.length, 1);
    assert.deepEqual(layout.mobile, []);
  });

  test('defaults a missing breakpoint to an empty array', async () => {
    const fetchImpl = fakeFetch([{ body: { layout: {} } }]);

    const { layout } = await createLayoutClient({ fetchImpl }).load();

    assert.deepEqual(layout, { desktop: [], mobile: [] });
  });

  test('throws with the message the server sent on a failure response', async () => {
    const fetchImpl = fakeFetch([
      {
        ok: false,
        status: 400,
        body: { error: 'INVALID_LAYOUT', message: 'desktop[0].w must be' },
      },
    ]);

    await assert.rejects(() => createLayoutClient({ fetchImpl }).load(), /400.*desktop\[0\]\.w/);
  });
});

describe('save', () => {
  test('PUTs only the breakpoint it was given', async () => {
    // The server leaves an absent breakpoint untouched, which is what makes
    // editing one breakpoint at a time safe.
    const fetchImpl = fakeFetch([{ body: { saved: ['mobile'] } }]);

    await createLayoutClient({ fetchImpl }).save({ mobile: [{ id: 'a', x: 0, y: 0, w: 4, h: 2 }] });

    const [call] = fetchImpl.calls;
    assert.equal(call.init.method, 'PUT');
    assert.deepEqual(Object.keys(call.body), ['mobile']);
  });

  test('sends both breakpoints when both are supplied', async () => {
    const fetchImpl = fakeFetch([{ body: { saved: ['desktop', 'mobile'] } }]);

    await createLayoutClient({ fetchImpl }).save({
      desktop: [{ id: 'a', x: 0, y: 0, w: 6, h: 2 }],
      mobile: [{ id: 'a', x: 0, y: 0, w: 4, h: 2 }],
    });

    assert.deepEqual(Object.keys(fetchImpl.calls[0].body).sort(), ['desktop', 'mobile']);
  });

  test('normalises nodes before sending, so the server does not reject them', async () => {
    const fetchImpl = fakeFetch([{ body: { saved: ['desktop'] } }]);

    await createLayoutClient({ fetchImpl }).save({ desktop: [{ id: 'a', w: 2, h: 2 }] });

    assert.deepEqual(fetchImpl.calls[0].body.desktop, [{ id: 'a', x: 0, y: 0, w: 2, h: 2 }]);
  });

  test('refuses an empty payload rather than sending one the server 400s', async () => {
    const fetchImpl = fakeFetch([]);

    await assert.rejects(() => createLayoutClient({ fetchImpl }).save({}), /nothing to save/);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('ignores a breakpoint the caller did not set', async () => {
    const fetchImpl = fakeFetch([{ body: { saved: ['desktop'] } }]);

    await createLayoutClient({ fetchImpl }).save({ desktop: [], mobile: undefined });

    assert.deepEqual(Object.keys(fetchImpl.calls[0].body), ['desktop']);
  });
});
