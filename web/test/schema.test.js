import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateConfig,
  parseConfig,
  buildFormModel,
  visibleFields,
  isVisible,
  applyDefaults,
  assertValidSchema,
  ConfigError,
} from '../src/shell/schema.js';

const schema = [
  { key: 'url', type: 'url', label: 'Endpoint', required: true },
  { key: 'refreshMs', type: 'number', default: 60_000, min: 1_000, max: 3_600_000 },
  {
    key: 'mode',
    type: 'select',
    default: 'public',
    options: [{ value: 'public' }, { value: 'api' }],
  },
  // Only relevant in API mode — declarative visibility, not a function.
  {
    key: 'apiKey',
    type: 'secret',
    required: true,
    visible: { field: 'mode', operator: 'eq', value: 'api' },
  },
];

test('the form and the validator are driven by the same array', () => {
  const values = { url: 'https://example.invalid/feed', mode: 'public' };

  const formKeys = buildFormModel(schema, values).map((f) => f.key);
  const { value } = validateConfig(schema, values);

  // The hidden `apiKey` is absent from BOTH the form and the validated set.
  assert.deepEqual(formKeys, ['url', 'refreshMs', 'mode']);
  assert.equal(value.apiKey, undefined);

  const apiForm = buildFormModel(schema, { ...values, mode: 'api' }).map((f) => f.key);
  assert.deepEqual(apiForm, ['url', 'refreshMs', 'mode', 'apiKey']);
});

test('a required field hidden by a condition is not required', () => {
  const publicMode = validateConfig(schema, {
    url: 'https://example.invalid/feed',
    mode: 'public',
  });
  assert.equal(publicMode.ok, true, 'apiKey is not demanded while hidden');

  const apiMode = validateConfig(schema, { url: 'https://example.invalid/feed', mode: 'api' });
  assert.equal(apiMode.ok, false, 'but it is demanded once visible');
  assert.deepEqual(apiMode.issues, [{ key: 'apiKey', message: 'is required' }]);
});

test('a hidden value is carried through rather than dropped', () => {
  const { value } = validateConfig(schema, {
    url: 'https://example.invalid/feed',
    mode: 'public',
    apiKey: 'typed-earlier',
  });
  assert.equal(value.apiKey, 'typed-earlier', 'flipping the mode back must not lose it');
});

test('visibility operators are data and survive a JSON round-trip', () => {
  const field = {
    key: 'x',
    type: 'text',
    visible: { field: 'mode', operator: 'eq', value: 'api' },
  };
  const roundTripped = JSON.parse(JSON.stringify(field));

  assert.equal(isVisible(roundTripped, { mode: 'api' }), true);
  assert.equal(isVisible(roundTripped, { mode: 'public' }), false);

  assert.equal(
    isVisible({ visible: { field: 'm', operator: 'neq', value: 'a' } }, { m: 'b' }),
    true
  );
  assert.equal(
    isVisible({ visible: { field: 'm', operator: 'in', value: ['a', 'b'] } }, { m: 'b' }),
    true
  );
  assert.equal(isVisible({ visible: { field: 'm', operator: 'truthy' } }, { m: 1 }), true);
  assert.equal(isVisible({ visible: { field: 'm', operator: 'falsy' } }, { m: 0 }), true);
  // An unknown operator hides the field rather than throwing at render time.
  assert.equal(isVisible({ visible: { field: 'm', operator: 'nope' } }, { m: 1 }), false);
  assert.equal(isVisible({ key: 'always' }, {}), true);
});

test('validation enforces each type', () => {
  const bad = validateConfig(schema, {
    url: 'not-a-url',
    refreshMs: 10,
    mode: 'nonsense',
  });
  const keys = bad.issues.map((i) => i.key).sort();
  assert.deepEqual(keys, ['mode', 'refreshMs', 'url']);
  assert.match(bad.issues.find((i) => i.key === 'refreshMs').message, /at least 1000/);
});

test('a numeric string from a form input is coerced, not rejected', () => {
  const result = validateConfig(schema, {
    url: 'https://example.invalid/feed',
    refreshMs: '90000',
    mode: 'public',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.refreshMs, 90_000, 'coerced to a number');
});

test('defaults are applied without overwriting a supplied value', () => {
  assert.equal(applyDefaults(schema, {}).refreshMs, 60_000);
  assert.equal(applyDefaults(schema, { refreshMs: 5_000 }).refreshMs, 5_000);
});

test('parseConfig throws a ConfigError carrying the issues', () => {
  assert.throws(
    () => parseConfig(schema, { mode: 'public' }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.deepEqual(err.issues, [{ key: 'url', message: 'is required' }]);
      return true;
    }
  );

  const ok = parseConfig(schema, { url: 'https://example.invalid/feed', mode: 'public' });
  assert.equal(ok.refreshMs, 60_000);
});

test('the form model masks secrets and never echoes their value', () => {
  const model = buildFormModel(schema, {
    url: 'https://example.invalid/feed',
    mode: 'api',
    apiKey: 'super-secret',
  });
  const apiKey = model.find((f) => f.key === 'apiKey');
  assert.equal(apiKey.masked, true);
  assert.equal(apiKey.value, '', 'a secret is never sent back to the browser form');
});

test('the form model reports per-field errors for the UI', () => {
  const model = buildFormModel(schema, { url: 'nope', mode: 'public' });
  assert.match(model.find((f) => f.key === 'url').error, /valid URL/);
  assert.equal(model.find((f) => f.key === 'mode').error, null);
});

test('a malformed schema is rejected at registration time', () => {
  assert.throws(() => assertValidSchema([{ key: 'a', type: 'wat' }], 'demo'), /unknown type/);
  assert.throws(() => assertValidSchema([{ type: 'text' }], 'demo'), /string key/);
  assert.throws(
    () =>
      assertValidSchema(
        [
          { key: 'a', type: 'text' },
          { key: 'a', type: 'text' },
        ],
        'demo'
      ),
    /duplicate key/
  );
  assert.throws(() => assertValidSchema([{ key: 's', type: 'select' }], 'demo'), /options array/);
  assert.throws(() => assertValidSchema('nope', 'demo'), /must be an array/);
});

test('visibleFields preserves declaration order', () => {
  const keys = visibleFields(schema, { mode: 'api' }).map((f) => f.key);
  assert.deepEqual(keys, ['url', 'refreshMs', 'mode', 'apiKey']);
});
