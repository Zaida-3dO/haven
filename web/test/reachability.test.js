import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { candidates, probe, resolve } from '../src/lib/reachability.js';

/**
 * Reachability runs in the browser and uses `fetch`, so these drive it through
 * a stubbed global `fetch` that records the order calls arrive in. The ORDER
 * is the thing under test as much as the result: probing in parallel, or
 * continuing past a responder, would still return a plausible URL while
 * breaking the two properties the design depends on.
 */
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * @param {Record<string, 'ok' | 'fail' | 'hang'>} behaviour
 */
function stubFetch(behaviour) {
  const calls = [];
  globalThis.fetch = (url, opts) => {
    calls.push(url);
    const how = behaviour[url] ?? 'fail';
    if (how === 'ok') return Promise.resolve({ type: 'opaque' });
    if (how === 'hang') {
      // Never settles on its own — only the probe's timeout can end it.
      return new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return Promise.reject(new Error('unreachable'));
  };
  return calls;
}

const app = (...urls) => ({ urls: urls.map((url, i) => ({ title: `U${i}`, url })) });

describe('candidates', () => {
  test('reads the stored order, which IS the probe priority', () => {
    assert.deepEqual(candidates(app('https://a.invalid', 'https://b.invalid')), [
      'https://a.invalid',
      'https://b.invalid',
    ]);
  });

  test('de-duplicates, so a dead host is not probed twice', () => {
    assert.deepEqual(candidates(app('https://a.invalid', 'https://a.invalid')), [
      'https://a.invalid',
    ]);
  });

  test('an app with no urls yields nothing', () => {
    assert.deepEqual(candidates({}), []);
    assert.deepEqual(candidates({ urls: [] }), []);
  });
});

describe('probe', () => {
  test('a responding host is reachable', async () => {
    stubFetch({ 'https://a.invalid': 'ok' });
    assert.equal(await probe('https://a.invalid'), true);
  });

  test('a rejecting host is unreachable rather than throwing', async () => {
    stubFetch({ 'https://a.invalid': 'fail' });
    assert.equal(await probe('https://a.invalid'), false);
  });

  test('uses a no-cors HEAD — we only care that it responded', async () => {
    let seen;
    globalThis.fetch = (_url, opts) => {
      seen = opts;
      return Promise.resolve({ type: 'opaque' });
    };
    await probe('https://a.invalid');
    assert.equal(seen.method, 'HEAD');
    assert.equal(seen.mode, 'no-cors');
  });

  test('times out rather than hanging on a dead host', async () => {
    stubFetch({ 'https://a.invalid': 'hang' });
    const started = Date.now();
    assert.equal(await probe('https://a.invalid', 50), false);
    assert.ok(Date.now() - started < 2000, 'should give up on the per-probe timeout');
  });
});

describe('resolve', () => {
  test('returns the FIRST responder and never probes past it', async () => {
    const calls = stubFetch({
      'https://first.invalid': 'fail',
      'https://second.invalid': 'ok',
      'https://third.invalid': 'ok',
    });

    const result = await resolve(
      app('https://first.invalid', 'https://second.invalid', 'https://third.invalid')
    );

    assert.deepEqual(result, { online: true, url: 'https://second.invalid' });
    // The third is NEVER fetched. This is the mixed-content decision: once the
    // https alias answers, lower-priority (often http://) variants are not
    // touched, which is what keeps the console free of net::ERR noise at home.
    assert.deepEqual(calls, ['https://first.invalid', 'https://second.invalid']);
  });

  test('probes SEQUENTIALLY, not in parallel', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    globalThis.fetch = () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      return new Promise((_, reject) =>
        setTimeout(() => {
          inFlight -= 1;
          reject(new Error('unreachable'));
        }, 10)
      );
    };

    await resolve(app('https://a.invalid', 'https://b.invalid', 'https://c.invalid'));

    // Parallel probing would fetch every variant every time — see the header
    // note in reachability.js.
    assert.equal(maxConcurrent, 1);
  });

  test('a dead host does not stall the chain behind it', async () => {
    const calls = stubFetch({
      'https://dead.invalid': 'hang',
      'https://alive.invalid': 'ok',
    });

    const result = await resolve(app('https://dead.invalid', 'https://alive.invalid'), 50);

    assert.deepEqual(result, { online: true, url: 'https://alive.invalid' });
    assert.deepEqual(calls, ['https://dead.invalid', 'https://alive.invalid']);
  });

  test('falls back to the first candidate when nothing answers', async () => {
    stubFetch({});
    const result = await resolve(app('https://a.invalid', 'https://b.invalid'));
    // Offline, but a click still has somewhere to go.
    assert.deepEqual(result, { online: false, url: 'https://a.invalid' });
  });

  test('an app with no urls resolves to nothing rather than throwing', async () => {
    stubFetch({});
    assert.deepEqual(await resolve({ urls: [] }), { online: false, url: null });
  });
});
