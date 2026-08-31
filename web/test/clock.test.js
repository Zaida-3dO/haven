import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  CONFIG_VERSION,
  ClockConfigError,
  assertUsableTimezone,
  configSchema,
  dataSource,
  formatDate,
  formatTime,
  getStubConfig,
  migrateConfig,
  timestampFrom,
} from '../src/widgets/clock/clock.js';
import { definition } from '../src/widgets/clock/index.js';
import { WidgetRegistry } from '../src/shell/registry.js';
import { migrateConfig as hostMigrate } from '../src/shell/migrate.js';
import { parseConfig, buildFormModel, visibleFields } from '../src/shell/schema.js';
import { doneData, errorData, staleData } from '../src/shell/panel-data.js';

/** A fixed instant so formatting assertions are not clock-dependent. */
const T = Date.UTC(2026, 7, 31, 14, 5, 9);

describe('clock metadata', () => {
  test('registers cleanly, which is what proves the schema is well-formed', () => {
    // The registry validates configSchema at registration, so this failing
    // means the schema is malformed rather than the test being wrong.
    const registry = new WidgetRegistry();
    const normalised = registry.register(definition);

    assert.equal(normalised.type, 'clock');
    assert.equal(normalised.name, 'Clock');
    assert.equal(normalised.searchable, true);
    assert.equal(typeof normalised.dataSource, 'function');
  });

  test('declares a mobile size distinct from its desktop size', () => {
    assert.notDeepEqual(definition.mobileSize, definition.defaultSize);
  });

  test('dataSource turns a config into a request for the host to fetch', () => {
    // The widget never reads the clock itself; the host supplies the time.
    assert.deepEqual(dataSource(getStubConfig()), { kind: 'now' });
  });

  test('the widget ships no timer of its own', async () => {
    // The contract's hardest rule to keep, and a clock is the most tempting
    // widget to break it in. Scanned against the source with comments
    // stripped, because the file discusses timers at length in prose and a
    // naive match would pass or fail on the commentary rather than the code.
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(new URL('../src/widgets/clock/clock.js', import.meta.url), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    assert.ok(
      !/\b(setInterval|setTimeout|requestAnimationFrame)\s*\(/.test(code),
      'the clock must not schedule its own work — the host owns every timer'
    );
  });
});

describe('configSchema', () => {
  test('the timezone field is hidden unless the source is a timezone', () => {
    const local = visibleFields(configSchema, { source: 'local' }).map((f) => f.key);
    const zoned = visibleFields(configSchema, { source: 'timezone' }).map((f) => f.key);

    assert.ok(!local.includes('timezone'));
    assert.ok(zoned.includes('timezone'));
  });

  test('a local-source config validates without a timezone', () => {
    const parsed = parseConfig(configSchema, { label: 'Home', source: 'local' });
    assert.equal(parsed.source, 'local');
  });

  test('an unknown select value is rejected', () => {
    assert.throws(
      () => parseConfig(configSchema, { label: 'Home', source: 'sundial' }),
      /source must be one of/
    );
  });

  test('an empty label is rejected because the field is required', () => {
    assert.throws(() => parseConfig(configSchema, { label: '', source: 'local' }), /label/);
  });

  test('the same schema drives the settings form, so the two cannot drift', () => {
    const model = buildFormModel(configSchema, { source: 'timezone', timezone: 'Europe/London' });
    const keys = model.map((f) => f.key);

    assert.deepEqual(keys, ['label', 'source', 'timezone', 'showSeconds']);
    assert.equal(model.find((f) => f.key === 'source').options.length, 2);
  });
});

describe('setConfig validation beyond the schema', () => {
  test('throws on a timezone Intl does not recognise', () => {
    // The schema can only say "a non-empty string"; this is the check it
    // cannot express, and the realistic bad-config case.
    assert.throws(
      () => assertUsableTimezone({ source: 'timezone', timezone: 'Mars/Olympus_Mons' }),
      ClockConfigError
    );
  });

  test('accepts a real timezone', () => {
    assert.doesNotThrow(() => assertUsableTimezone({ source: 'timezone', timezone: 'Asia/Tokyo' }));
  });

  test('does not check the timezone at all when the source is local', () => {
    // A stale timezone left over from a previous mode must not fail the config.
    assert.doesNotThrow(() => assertUsableTimezone({ source: 'local', timezone: 'nonsense' }));
  });
});

describe('config migration v1 to v2', () => {
  test('the host runs the hook and translates use24Hour into showSeconds', () => {
    const stored = { configVersion: 1, label: 'Home', source: 'local', use24Hour: true };

    const { config, migrated, from, to } = hostMigrate(definition, stored);

    assert.equal(migrated, true);
    assert.equal(from, 1);
    assert.equal(to, CONFIG_VERSION);
    assert.equal(config.showSeconds, 'yes');
    assert.ok(!('use24Hour' in config), 'the retired v1 field is dropped');
  });

  test('a v1 config without use24Hour migrates to the default', () => {
    const { config } = hostMigrate(definition, { configVersion: 1, label: 'Home' });
    assert.equal(config.showSeconds, 'no');
  });

  test('a current-version config is passed through unmigrated', () => {
    const { migrated } = hostMigrate(definition, { configVersion: CONFIG_VERSION, label: 'Home' });
    assert.equal(migrated, false);
  });

  test('the migrated config then passes schema validation', () => {
    // Migration that produces something the validator rejects would be worse
    // than no migration, so the two are checked together.
    const { config } = hostMigrate(definition, {
      configVersion: 1,
      label: 'Home',
      source: 'local',
      use24Hour: false,
    });

    assert.doesNotThrow(() => parseConfig(configSchema, config));
  });

  test('the hook does not mutate the config it is handed', () => {
    const stored = { label: 'Home', use24Hour: true };
    migrateConfig(stored, 1);
    assert.equal(stored.use24Hour, true);
  });
});

describe('getStubConfig', () => {
  test('the registry stub validates, so an added clock works immediately', () => {
    const registry = new WidgetRegistry();
    registry.register(definition);

    const stub = registry.stubConfig('clock');

    assert.equal(stub.configVersion, CONFIG_VERSION);
    assert.doesNotThrow(() => parseConfig(configSchema, stub));
  });
});

describe('formatting', () => {
  test('renders the time in the configured timezone, not the local one', () => {
    const tokyo = formatTime(T, { source: 'timezone', timezone: 'Asia/Tokyo', showSeconds: 'no' });
    const utc = formatTime(T, { source: 'timezone', timezone: 'UTC', showSeconds: 'no' });

    assert.equal(utc, '14:05');
    assert.equal(tokyo, '23:05');
  });

  test('shows seconds only when configured to', () => {
    const base = { source: 'timezone', timezone: 'UTC' };

    assert.equal(formatTime(T, { ...base, showSeconds: 'yes' }), '14:05:09');
    assert.equal(formatTime(T, { ...base, showSeconds: 'no' }), '14:05');
  });

  test('the date line follows the same timezone as the time', () => {
    const late = Date.UTC(2026, 7, 31, 23, 30);

    assert.match(formatDate(late, { source: 'timezone', timezone: 'UTC' }), /31 August/);
    assert.match(formatDate(late, { source: 'timezone', timezone: 'Asia/Tokyo' }), /1 September/);
  });
});

describe('timestampFrom', () => {
  test('reads a timestamp from either payload shape the host may send', () => {
    assert.equal(timestampFrom(doneData({ timestamp: T })), T);
    assert.equal(timestampFrom(doneData(T)), T);
  });

  test('returns null when there is no value yet, rather than NaN', () => {
    assert.equal(timestampFrom(errorData(new Error('down'))), null);
    assert.equal(timestampFrom(null), null);
  });

  test('stale data still carries a usable timestamp', () => {
    // The soft-notice path: state stays `done` and the value is still drawn.
    const stale = staleData({ timestamp: T });

    assert.equal(stale.state, 'done');
    assert.equal(timestampFrom(stale), T);
    assert.equal(stale.notices[0].stale, true);
  });
});
