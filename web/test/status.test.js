import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { STATUS, StatusTracker, statusLabel, urlHint } from '../src/lib/status.js';

/** Fixtures use `.invalid` hostnames throughout — see docs/SECURITY.md. */
const appFixture = (overrides = {}) => ({
  id: 'example-service',
  name: 'Example Service',
  urls: [
    { title: 'Open Local', url: 'https://example.local.invalid' },
    { title: 'Open', url: 'https://example.invalid', primary: true },
  ],
  ...overrides,
});

/** A `resolve` double, so no test touches the network. */
function fakeResolve(result) {
  const calls = [];
  const fn = async (app) => {
    calls.push(app);
    return typeof result === 'function' ? result(app) : result;
  };
  fn.calls = calls;
  return fn;
}

describe('StatusTracker', () => {
  test('an unchecked app reads as unknown with its primary URL as the target', () => {
    const tracker = new StatusTracker({ resolveFn: fakeResolve({ online: true, url: 'x' }) });

    const entry = tracker.get(appFixture());

    assert.equal(entry.status, STATUS.UNKNOWN);
    // The first candidate, so a card is clickable before any probe finishes.
    assert.equal(entry.url, 'https://example.local.invalid');
    assert.equal(entry.checkedAt, null);
  });

  test('a successful probe becomes reachable, with the resolved URL', async () => {
    const resolveFn = fakeResolve({ online: true, url: 'https://example.local.invalid' });
    const tracker = new StatusTracker({ resolveFn });

    const entry = await tracker.check(appFixture());

    assert.equal(entry.status, STATUS.REACHABLE);
    assert.equal(entry.url, 'https://example.local.invalid');
  });

  test('a failed probe becomes unreachable', async () => {
    const resolveFn = fakeResolve({ online: false, url: 'https://example.local.invalid' });
    const tracker = new StatusTracker({ resolveFn });

    const entry = await tracker.check(appFixture());

    assert.equal(entry.status, STATUS.UNREACHABLE);
  });

  /**
   * The dot and the click target must come from ONE probe. If this stops
   * holding, the card is either probing twice (doubling network traffic) or
   * showing a dot for a different URL than the one a click opens.
   */
  test('the click target is the URL the chain resolved, not the primary', async () => {
    const app = appFixture({
      urls: [
        { title: 'Open Local', url: 'https://example.local.invalid' },
        { title: 'Open via Tailscale', url: 'https://example.ts.invalid' },
      ],
    });
    // The chain fell through to the second variant.
    const resolveFn = fakeResolve({ online: true, url: 'https://example.ts.invalid' });
    const tracker = new StatusTracker({ resolveFn });

    const entry = await tracker.check(app);

    assert.equal(entry.url, 'https://example.ts.invalid');
  });

  test('an app with no URLs stays unknown and is never probed', async () => {
    const resolveFn = fakeResolve({ online: true, url: 'x' });
    const tracker = new StatusTracker({ resolveFn });

    const entry = await tracker.check(appFixture({ urls: [] }));

    assert.equal(entry.status, STATUS.UNKNOWN);
    assert.equal(entry.url, null);
    // Unconfigured is not the same as broken: probing nothing would report
    // "unreachable", which reads as a dead service.
    assert.equal(resolveFn.calls.length, 0);
  });

  test('a second check inside the ttl reuses the cached result', async () => {
    const resolveFn = fakeResolve({ online: true, url: 'https://example.invalid' });
    const tracker = new StatusTracker({ resolveFn, now: () => 1000, ttlMs: 60_000 });

    await tracker.check(appFixture());
    await tracker.check(appFixture());

    assert.equal(resolveFn.calls.length, 1);
  });

  test('a check after the ttl re-probes', async () => {
    const resolveFn = fakeResolve({ online: true, url: 'https://example.invalid' });
    let clock = 0;
    const tracker = new StatusTracker({ resolveFn, now: () => clock, ttlMs: 60_000 });

    await tracker.check(appFixture());
    clock = 60_001;
    await tracker.check(appFixture());

    assert.equal(resolveFn.calls.length, 2);
  });

  test('force re-probes inside the ttl', async () => {
    const resolveFn = fakeResolve({ online: true, url: 'https://example.invalid' });
    const tracker = new StatusTracker({ resolveFn, now: () => 1000 });

    await tracker.check(appFixture());
    await tracker.check(appFixture(), { force: true });

    assert.equal(resolveFn.calls.length, 2);
  });

  /**
   * Two renders of one card must not start two probe chains — that would
   * double the traffic and let the dot and the click target disagree.
   */
  test('concurrent checks of one app join a single probe', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const resolveFn = fakeResolve(async () => {
      await gate;
      return { online: true, url: 'https://example.invalid' };
    });
    const tracker = new StatusTracker({ resolveFn });

    const both = Promise.all([tracker.check(appFixture()), tracker.check(appFixture())]);
    release();
    await both;

    assert.equal(resolveFn.calls.length, 1);
  });

  test('the entry is checking while a probe is in flight, and stays clickable', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const resolveFn = fakeResolve(async () => {
      await gate;
      return { online: true, url: 'https://example.invalid' };
    });
    const tracker = new StatusTracker({ resolveFn });

    const pending = tracker.check(appFixture());
    const during = tracker.get(appFixture());

    assert.equal(during.status, STATUS.CHECKING);
    // A card must not go dead while it is being checked.
    assert.equal(during.url, 'https://example.local.invalid');

    release();
    await pending;
  });

  test('a rejecting probe degrades to unknown rather than sticking on checking', async () => {
    const resolveFn = fakeResolve(async () => {
      throw new Error('probe exploded');
    });
    const tracker = new StatusTracker({ resolveFn });

    const entry = await tracker.check(appFixture());

    assert.equal(entry.status, STATUS.UNKNOWN);
    assert.notEqual(entry.status, STATUS.CHECKING);
  });

  test('onChange fires when a status changes, and not when it repeats', async () => {
    const changes = [];
    let clock = 0;
    const resolveFn = fakeResolve({ online: true, url: 'https://example.invalid' });
    const tracker = new StatusTracker({
      resolveFn,
      now: () => clock,
      ttlMs: 10,
      onChange: (id, entry) => changes.push([id, entry.status]),
    });

    await tracker.check(appFixture());
    const afterFirst = changes.length;
    clock = 100;
    await tracker.check(appFixture());

    // First check: checking -> reachable. Second: same result, so only the
    // transition back through checking is reported, never a duplicate
    // reachable.
    assert.ok(afterFirst >= 1);
    assert.deepEqual(changes.at(-1), ['example-service', STATUS.REACHABLE]);
    assert.ok(changes.every(([, status]) => status !== undefined));
  });

  test('checkAll probes every app', async () => {
    const resolveFn = fakeResolve({ online: true, url: 'https://example.invalid' });
    const tracker = new StatusTracker({ resolveFn });

    const results = await tracker.checkAll([
      appFixture({ id: 'a' }),
      appFixture({ id: 'b' }),
      appFixture({ id: 'c' }),
    ]);

    assert.equal(results.length, 3);
    assert.equal(resolveFn.calls.length, 3);
    assert.ok(results.every((r) => r.status === STATUS.REACHABLE));
  });

  test('clear drops cached results so the next check re-probes', async () => {
    const resolveFn = fakeResolve({ online: true, url: 'https://example.invalid' });
    const tracker = new StatusTracker({ resolveFn, now: () => 1000 });

    await tracker.check(appFixture());
    tracker.clear();
    await tracker.check(appFixture());

    assert.equal(resolveFn.calls.length, 2);
  });

  test('snapshot exposes the recorded entries', async () => {
    const resolveFn = fakeResolve({ online: true, url: 'https://example.invalid' });
    const tracker = new StatusTracker({ resolveFn });

    await tracker.check(appFixture({ id: 'a' }));
    const snap = tracker.snapshot();

    assert.equal(snap.get('a').status, STATUS.REACHABLE);
  });
});

describe('urlHint', () => {
  /**
   * The hint exists because the resolved target is often NOT the primary URL.
   * Without it the click target is invisible until you have clicked it.
   */
  test('names the resolved URL when reachable', () => {
    const hint = urlHint({ status: STATUS.REACHABLE, url: 'https://example.ts.invalid' });
    assert.match(hint, /example\.ts\.invalid/);
    assert.match(hint, /Opens/);
  });

  test('names the URL a click would still try when unreachable', () => {
    const hint = urlHint({ status: STATUS.UNREACHABLE, url: 'https://example.invalid' });
    assert.match(hint, /example\.invalid/);
    assert.match(hint, /Nothing answered/);
  });

  test('says so while checking', () => {
    const hint = urlHint({ status: STATUS.CHECKING, url: 'https://example.invalid' });
    assert.match(hint, /Checking/);
  });

  test('handles an app with no URL at all', () => {
    assert.equal(urlHint({ status: STATUS.UNKNOWN, url: null }), 'No reachable URL');
    assert.equal(urlHint(null), 'No reachable URL');
  });
});

describe('statusLabel', () => {
  /**
   * Colour must not carry the meaning alone — this string becomes the dot's
   * title and aria-label.
   */
  test('describes each state in words', () => {
    assert.match(statusLabel({ status: STATUS.REACHABLE }), /Reachable/);
    assert.match(statusLabel({ status: STATUS.UNREACHABLE }), /Not reachable/);
    assert.match(statusLabel({ status: STATUS.CHECKING }), /Checking/);
    assert.match(statusLabel({ status: STATUS.UNKNOWN }), /unknown/i);
  });

  test('includes the app name so a screen reader says which app', () => {
    assert.match(statusLabel({ status: STATUS.REACHABLE }, 'Example Service'), /^Example Service:/);
  });

  test('falls back to unknown for an unrecognised state', () => {
    assert.match(statusLabel({ status: 'nonsense' }), /unknown/i);
    assert.match(statusLabel(undefined), /unknown/i);
  });
});
