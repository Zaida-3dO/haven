import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LIMITS,
  NoticeValidationError,
  SEVERITIES,
  parseDue,
  parseNotice,
  parseNotices,
} from '../src/notices/envelope.js';

/**
 * The envelope is the whole value of the feature: one shape, enforced at the
 * one point everything enters through. These tests are therefore mostly about
 * what is REFUSED, because a malformed notice that gets stored is a malformed
 * notice every future renderer has to defend against.
 *
 * Fixtures are invented, with `.invalid` hostnames — a notice is personal data
 * and none of it belongs in a public repo.
 */

const valid = () => ({
  id: 'bin-day',
  severity: 'warn',
  title: 'Recycling goes out tonight',
  body: 'Blue bin, kerbside by 07:00.',
  due: '2026-09-02T18:00:00Z',
  source: 'chores',
  url: 'https://chores.invalid/bin-day',
  actions: [{ id: 'done', label: 'Done' }],
});

test('a well-formed notice round-trips with every field preserved', () => {
  const notice = parseNotice(valid());

  assert.equal(notice.id, 'bin-day');
  assert.equal(notice.severity, 'warn');
  assert.equal(notice.title, 'Recycling goes out tonight');
  assert.equal(notice.body, 'Blue bin, kerbside by 07:00.');
  assert.equal(notice.due, '2026-09-02T18:00:00.000Z');
  assert.equal(notice.source, 'chores');
  assert.equal(notice.url, 'https://chores.invalid/bin-day');
  assert.deepEqual(notice.actions[0].id, 'done');
});

test('severity defaults to info — the level that cannot mislead', () => {
  const notice = parseNotice({ ...valid(), severity: undefined });
  assert.equal(notice.severity, 'info');
});

test('an unrecognised severity is refused, and the error names the options', () => {
  assert.throws(
    () => parseNotice({ ...valid(), severity: 'critical' }),
    (error) => {
      assert.ok(error instanceof NoticeValidationError);
      assert.equal(error.field, 'severity');
      // The sender has to be able to fix it from the message alone.
      for (const level of SEVERITIES) assert.match(error.message, new RegExp(level));
      assert.match(error.message, /critical/);
      return true;
    }
  );
});

test('id, title and source are required', () => {
  for (const field of ['id', 'title', 'source']) {
    const input = { ...valid() };
    delete input[field];
    assert.throws(
      () => parseNotice(input),
      (error) => error.field === field,
      `omitting ${field} should be refused`
    );
  }
});

test('a whitespace-only title is empty, not a title', () => {
  // Otherwise it renders as a blank tile — a bug that arrives silently.
  assert.throws(() => parseNotice({ ...valid(), title: '   ' }), /must not be empty/);
});

test('strings are trimmed', () => {
  const notice = parseNotice({ ...valid(), title: '  Boiler service due  ' });
  assert.equal(notice.title, 'Boiler service due');
});

test('an over-long field is refused with its limit and actual length', () => {
  const title = 'x'.repeat(LIMITS.title + 1);
  assert.throws(
    () => parseNotice({ ...valid(), title }),
    (error) => {
      assert.equal(error.field, 'title');
      assert.match(error.message, new RegExp(String(LIMITS.title)));
      assert.match(error.message, new RegExp(String(LIMITS.title + 1)));
      return true;
    }
  );
});

test('body and url are optional and normalise to null', () => {
  const notice = parseNotice({ id: 'a', title: 'A thing', source: 'chores' });
  assert.equal(notice.body, null);
  assert.equal(notice.url, null);
  assert.equal(notice.due, null);
  assert.deepEqual(notice.actions, []);
});

test('an empty-string body is null rather than an empty paragraph', () => {
  assert.equal(parseNotice({ ...valid(), body: '   ' }).body, null);
});

// ── URLs ──────────────────────────────────────────────────────────────────

test('a javascript: url is refused even though it parses', () => {
  // `new URL` accepts it happily, and the widget renders `url` as a link.
  assert.throws(
    () => parseNotice({ ...valid(), url: 'javascript:alert(1)' }),
    (error) => {
      assert.equal(error.field, 'url');
      assert.match(error.message, /http or https/);
      return true;
    }
  );
});

test('a relative url is refused — a notice is not rendered in a page context', () => {
  assert.throws(() => parseNotice({ ...valid(), url: '/somewhere' }), /absolute http\(s\) URL/);
});

test('an http url is allowed — a LAN service is not https', () => {
  const notice = parseNotice({ ...valid(), url: 'http://chores.invalid/x' });
  assert.equal(notice.url, 'http://chores.invalid/x');
});

// ── Due dates ─────────────────────────────────────────────────────────────

test('due normalises to UTC, so a lexical sort is a chronological sort', () => {
  // Two sources expressing the same instant differently must compare equal.
  const withOffset = parseDue('2026-09-02T19:00:00+01:00');
  const withZulu = parseDue('2026-09-02T18:00:00Z');
  assert.equal(withOffset, withZulu);
});

test('a date-only due is accepted as midnight UTC', () => {
  // Chores are routinely day-granular; refusing the most natural thing to
  // send would push a workaround into every source.
  assert.equal(parseDue('2026-09-02'), '2026-09-02T00:00:00.000Z');
});

test('a human date string is refused despite Date.parse accepting it', () => {
  // "March 2 2026" is ambiguous across locales, and Date.parse takes it.
  assert.throws(() => parseDue('March 2 2026'), /ISO-8601/);
});

test('nonsense in due is refused rather than becoming Invalid Date', () => {
  assert.throws(() => parseDue('tomorrow'), /ISO-8601/);
});

test('an absent due is null, not an error', () => {
  assert.equal(parseDue(undefined), null);
  assert.equal(parseDue(null), null);
  assert.equal(parseDue(''), null);
});

// ── Actions ───────────────────────────────────────────────────────────────

test('an action needs both an id and a label', () => {
  assert.throws(
    () => parseNotice({ ...valid(), actions: [{ label: 'Done' }] }),
    (error) => error.field === 'actions[0].id'
  );
  assert.throws(
    () => parseNotice({ ...valid(), actions: [{ id: 'done' }] }),
    (error) => error.field === 'actions[0].label'
  );
});

test('an action defaults to dismissing the notice and to POST', () => {
  const [action] = parseNotice({ ...valid(), actions: [{ id: 'done', label: 'Done' }] }).actions;
  assert.equal(action.dismisses, true);
  assert.equal(action.method, 'POST');
});

test('duplicate action ids are refused — the callback would be ambiguous', () => {
  assert.throws(
    () =>
      parseNotice({
        ...valid(),
        actions: [
          { id: 'done', label: 'Done' },
          { id: 'done', label: 'Also done' },
        ],
      }),
    /Duplicate action id/
  );
});

test('an action target must be a safe absolute url', () => {
  assert.throws(
    () => parseNotice({ ...valid(), actions: [{ id: 'a', label: 'A', target: 'file:///etc' }] }),
    (error) => error.field === 'actions[0].target'
  );
});

test('too many actions are refused rather than rendering an unusable tile', () => {
  const actions = Array.from({ length: LIMITS.actions + 1 }, (_, i) => ({
    id: `a${i}`,
    label: `A${i}`,
  }));
  assert.throws(() => parseNotice({ ...valid(), actions }), /at most/);
});

// ── Unknown keys, and the batch ───────────────────────────────────────────

test('unknown keys are dropped, not rejected and not stored', () => {
  const notice = parseNotice({
    ...valid(),
    entityId: 'sensor.hidden',
    internalHost: 'nas.invalid',
  });
  assert.equal(notice.entityId, undefined);
  assert.equal(notice.internalHost, undefined);
  // Only the envelope's own fields survive.
  assert.deepEqual(Object.keys(notice).sort(), [
    'actions',
    'body',
    'due',
    'id',
    'severity',
    'source',
    'title',
    'url',
  ]);
});

test('a non-object notice is refused', () => {
  for (const input of ['a string', 42, null, ['nested']]) {
    assert.throws(() => parseNotice(input), NoticeValidationError);
  }
});

test('a batch reports EVERY bad entry, not just the first', () => {
  // A source posting twenty notices should learn about all three broken ones
  // in one round trip rather than looping post-fix-post.
  const { notices, errors } = parseNotices([
    valid(),
    { ...valid(), id: 'no-title', title: '' },
    { ...valid(), id: 'bad-sev', severity: 'nope' },
  ]);

  assert.equal(notices.length, 1);
  assert.equal(errors.length, 2);
  assert.deepEqual(
    errors.map((e) => e.index),
    [1, 2]
  );
  assert.equal(errors[0].field, 'title');
  assert.equal(errors[1].field, 'severity');
});

test('a duplicate id within one batch is reported — one would silently win', () => {
  const { errors } = parseNotices([valid(), { ...valid(), title: 'Different' }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Duplicate notice id/);
});

test('a single notice may be passed without wrapping it in an array', () => {
  const { notices, errors } = parseNotices(valid());
  assert.equal(notices.length, 1);
  assert.deepEqual(errors, []);
});

test('defaultSource fills in only when the sender omits one', () => {
  const stamped = parseNotices([{ id: 'a', title: 'A' }], { defaultSource: 'home-assistant' });
  assert.equal(stamped.notices[0].source, 'home-assistant');

  const explicit = parseNotices([{ id: 'a', title: 'A', source: 'chores' }], {
    defaultSource: 'home-assistant',
  });
  assert.equal(explicit.notices[0].source, 'chores');
});

// ── Action dispatch ───────────────────────────────────────────────────────

test('a Home Assistant service survives ingest', () => {
  // It is parsed explicitly precisely because unknown keys are dropped: an
  // action field this function does not name would silently become a "Done"
  // button that calls nothing.
  const [action] = parseNotice({
    ...valid(),
    actions: [
      {
        id: 'lock',
        label: 'Lock the door',
        service: 'lock/lock',
        data: { entity_id: 'lock.front' },
      },
    ],
  }).actions;

  assert.equal(action.service, 'lock/lock');
  assert.deepEqual(action.data, { entity_id: 'lock.front' });
});

test('a service must be a domain/service pair, not a path', () => {
  // An action arrived from outside; it does not get to choose an arbitrary
  // URL on the Home Assistant host.
  for (const service of ['../../config', '/api/config', 'onlyonepart', 'http://evil.invalid/']) {
    assert.throws(
      () => parseNotice({ ...valid(), actions: [{ id: 'a', label: 'A', service }] }),
      (error) => error.field === 'actions[0].service',
      service
    );
  }
});

test('an action may not declare both a service and a target', () => {
  // Two dispatch routes on one button is an ambiguity the backend would have
  // to break arbitrarily.
  assert.throws(
    () =>
      parseNotice({
        ...valid(),
        actions: [
          { id: 'a', label: 'A', service: 'lock/lock', target: 'https://elsewhere.invalid/x' },
        ],
      }),
    /either a service or a target, not both/
  );
});

test('service data must be an object', () => {
  assert.throws(
    () =>
      parseNotice({
        ...valid(),
        actions: [{ id: 'a', label: 'A', service: 'lock/lock', data: 'entity_id=lock.front' }],
      }),
    (error) => error.field === 'actions[0].data'
  );
});

test('an action with neither service nor target is a plain Done button', () => {
  const [action] = parseNotice({ ...valid(), actions: [{ id: 'done', label: 'Done' }] }).actions;
  assert.equal(action.service, null);
  assert.equal(action.target, null);
  assert.equal(action.data, null);
});
