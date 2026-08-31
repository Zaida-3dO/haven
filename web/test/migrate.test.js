import test from 'node:test';
import assert from 'node:assert/strict';

import { migrateConfig, MigrationError } from '../src/shell/migrate.js';

test('a v1 config migrates to v2 on load', () => {
  const definition = {
    type: 'weather',
    configVersion: 2,
    // v1 stored a bare city name; v2 splits it into a location object.
    migrateConfig(config, from) {
      if (from < 2) {
        const { city, ...rest } = config;
        return { ...rest, location: { name: city } };
      }
      return config;
    },
  };

  const stored = { configVersion: 1, city: 'Springfield', units: 'metric' };
  const result = migrateConfig(definition, stored);

  assert.equal(result.migrated, true);
  assert.equal(result.from, 1);
  assert.equal(result.to, 2);
  assert.deepEqual(result.config, {
    configVersion: 2,
    location: { name: 'Springfield' },
    units: 'metric',
  });
  assert.deepEqual(
    stored,
    { configVersion: 1, city: 'Springfield', units: 'metric' },
    'input untouched'
  );
});

test('a config already at the current version is not migrated', () => {
  const definition = {
    type: 'weather',
    configVersion: 2,
    migrateConfig: () => {
      throw new Error('should not be called');
    },
  };
  const result = migrateConfig(definition, { configVersion: 2, location: { name: 'x' } });
  assert.equal(result.migrated, false);
  assert.equal(result.config.location.name, 'x');
});

test('a config with no version is treated as v1', () => {
  const definition = {
    type: 'demo',
    configVersion: 2,
    migrateConfig: (config) => ({ ...config, migrated: true }),
  };
  const result = migrateConfig(definition, { a: 1 });
  assert.equal(result.from, 1);
  assert.equal(result.config.migrated, true);
});

test('a widget with no migration hook cannot silently accept an old config', () => {
  assert.throws(
    () => migrateConfig({ type: 'demo', configVersion: 3 }, { configVersion: 1 }),
    MigrationError
  );
});

test('a config from a newer build is refused rather than downgraded', () => {
  assert.throws(
    () => migrateConfig({ type: 'demo', configVersion: 1 }, { configVersion: 5 }),
    /newer Haven/
  );
});

test('a throwing migration hook is reported as a MigrationError', () => {
  const definition = {
    type: 'demo',
    configVersion: 2,
    migrateConfig: () => {
      throw new Error('bad shape');
    },
  };
  assert.throws(
    () => migrateConfig(definition, { configVersion: 1 }),
    (err) => {
      assert.ok(err instanceof MigrationError);
      assert.match(err.message, /bad shape/);
      return true;
    }
  );
});

test('a migration hook returning a non-object is rejected', () => {
  const definition = { type: 'demo', configVersion: 2, migrateConfig: () => undefined };
  assert.throws(() => migrateConfig(definition, { configVersion: 1 }), /expected a config object/);
});
