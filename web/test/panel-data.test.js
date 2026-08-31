import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadingData,
  doneData,
  errorData,
  staleData,
  LOADING,
  DONE,
  ERROR,
} from '../src/shell/panel-data.js';

test('the revision only increments when the value actually changes', () => {
  const first = doneData({ n: 1 });
  assert.equal(first.state, DONE);
  assert.equal(first.revision, 1);

  const same = doneData({ n: 1 }, { previous: first });
  assert.equal(same.revision, 1, 'identical data keeps the revision, so no redraw');

  const changed = doneData({ n: 2 }, { previous: same });
  assert.equal(changed.revision, 2);
});

test('deep-equal values are treated as unchanged', () => {
  const first = doneData({ a: [1, 2], b: { c: 3 } });
  const same = doneData({ a: [1, 2], b: { c: 3 } }, { previous: first });
  assert.equal(same.revision, first.revision);
});

test('loading keeps the previous value so a refresh does not flash a spinner', () => {
  const done = doneData({ n: 1 });
  const loading = loadingData(done);
  assert.equal(loading.state, LOADING);
  assert.deepEqual(loading.value, { n: 1 });
  assert.equal(loading.revision, done.revision);
});

test('an error retains the last known value and carries the message', () => {
  const done = doneData({ n: 1 });
  const failed = errorData(new Error('connector down'), { previous: done });

  assert.equal(failed.state, ERROR);
  assert.deepEqual(failed.value, { n: 1 }, 'stale data beats an empty tile');
  assert.equal(failed.errors[0].message, 'connector down');
});

test('a soft notice is not a hard error', () => {
  const previous = doneData({ n: 1 });
  const stale = staleData({ n: 1 }, { previous, reason: 'Showing cached data' });

  // Stale-but-usable stays `done` — it renders with a marker, not an error box.
  assert.equal(stale.state, DONE);
  assert.equal(stale.errors.length, 0);
  assert.equal(stale.notices[0].stale, true);
  assert.match(stale.notices[0].message, /cached/);
});

test('the payload is frozen so a widget cannot mutate what the host owns', () => {
  const data = doneData({ n: 1 });
  assert.throws(() => {
    'use strict';
    data.state = 'tampered';
  }, TypeError);
});

test('two distinct unserialisable values are assumed changed, not silently withheld', () => {
  const makeCircular = () => {
    const o = {};
    o.self = o;
    return o;
  };

  const first = doneData(makeCircular());
  // A different object that cannot be JSON-compared: we must not conclude
  // "unchanged" and withhold the update from the widget.
  const second = doneData(makeCircular(), { previous: first });
  assert.equal(second.revision, first.revision + 1);
});

test('the identical object reference is genuinely unchanged', () => {
  const value = { n: 1 };
  const first = doneData(value);
  const second = doneData(value, { previous: first });
  assert.equal(second.revision, first.revision, 'same reference means no redraw');
});

test('the first payload after loading always counts as a change', () => {
  const loading = loadingData();
  const done = doneData({ n: 1 }, { previous: loading });
  assert.equal(done.revision, 1);
});
