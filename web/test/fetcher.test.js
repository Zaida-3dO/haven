import test from 'node:test';
import assert from 'node:assert/strict';

import { Fetcher, cacheKey } from '../src/shell/fetcher.js';

/** A transport that resolves when we say so, to hold requests in flight. */
function deferredTransport() {
  const pending = [];
  const transport = () =>
    new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  return { transport, pending };
}

test('two widgets on one endpoint produce one request', async () => {
  const { transport, pending } = deferredTransport();
  const fetcher = new Fetcher({ transport });

  // Both widgets ask at the same moment, before any response arrives.
  const a = fetcher.fetch({ url: '/api/weather' });
  const b = fetcher.fetch({ url: '/api/weather' });

  assert.equal(pending.length, 1, 'the second caller joined the in-flight request');
  assert.equal(fetcher.requestCount, 1);

  pending[0].resolve({ tempC: 11 });
  const [ra, rb] = await Promise.all([a, b]);

  assert.deepEqual(ra.value, { tempC: 11 });
  assert.deepEqual(rb.value, { tempC: 11 }, 'both widgets get the same payload');
  assert.equal(fetcher.requestCount, 1, 'exactly one request left the browser');
});

test('a request arriving just after a response is served from cache', async () => {
  let calls = 0;
  let now = 0;
  const fetcher = new Fetcher({
    transport: async () => ({ n: ++calls }),
    now: () => now,
    cacheMs: 30_000,
  });

  await fetcher.fetch({ url: '/api/x' });
  now += 1_000;
  const second = await fetcher.fetch({ url: '/api/x' });

  assert.equal(fetcher.requestCount, 1, 'still one request inside the cache window');
  assert.equal(second.fromCache, true);

  now += 30_000; // cache expired
  await fetcher.fetch({ url: '/api/x' });
  assert.equal(fetcher.requestCount, 2, 'refetches once the cache window passes');
});

test('different endpoints are not deduplicated together', async () => {
  const fetcher = new Fetcher({ transport: async ({ url }) => url });
  await Promise.all([fetcher.fetch({ url: '/api/a' }), fetcher.fetch({ url: '/api/b' })]);
  assert.equal(fetcher.requestCount, 2);
});

test('a failure clears the in-flight entry so the key is not wedged', async () => {
  let calls = 0;
  const fetcher = new Fetcher({
    transport: async () => {
      calls += 1;
      throw new Error('boom');
    },
  });

  await assert.rejects(() => fetcher.fetch({ url: '/api/x' }));
  await assert.rejects(() => fetcher.fetch({ url: '/api/x' }));
  assert.equal(calls, 2, 'the second attempt actually retried');
});

test('fetchWithFallback serves stale cache when the request fails', async () => {
  let mode = 'ok';
  let now = 0;
  const fetcher = new Fetcher({
    transport: async () => {
      if (mode === 'fail') throw new Error('connector down');
      return { v: 1 };
    },
    now: () => now,
    cacheMs: 1_000,
  });

  const first = await fetcher.fetchWithFallback({ url: '/api/x' });
  assert.equal(first.stale, false);

  now += 5_000; // past the cache window, so it will try the network
  mode = 'fail';
  const second = await fetcher.fetchWithFallback({ url: '/api/x' });

  assert.equal(second.stale, true, 'stale-but-usable rather than an error');
  assert.deepEqual(second.value, { v: 1 });
});

test('fetchWithFallback still throws when there is no cache to fall back to', async () => {
  const fetcher = new Fetcher({
    transport: async () => {
      throw new Error('connector down');
    },
  });
  await assert.rejects(() => fetcher.fetchWithFallback({ url: '/api/x' }), /connector down/);
});

test('cacheKey distinguishes method and body but honours an explicit key', () => {
  assert.equal(cacheKey({ url: '/a' }), cacheKey({ url: '/a' }));
  assert.notEqual(cacheKey({ url: '/a' }), cacheKey({ url: '/b' }));
  assert.notEqual(cacheKey({ url: '/a', options: { method: 'POST' } }), cacheKey({ url: '/a' }));
  assert.equal(cacheKey({ url: '/a', key: 'shared' }), cacheKey({ url: '/b', key: 'shared' }));
});
