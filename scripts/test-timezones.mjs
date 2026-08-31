#!/usr/bin/env node
/**
 * Run a test file under several timezones.
 *
 * Why this exists rather than a `TZ=... node --test` one-liner: on Windows
 * (and under Git Bash) a `TZ=value command` prefix does NOT reach Node —
 * `process.env.TZ` arrives undefined and Node falls back to the OS timezone.
 * A cross-timezone matrix written that way silently runs the SAME zone every
 * time and proves nothing, which is exactly how a timezone bug ships green.
 * Passing `env` to a spawned child does work, on every platform.
 *
 * Usage: node scripts/test-timezones.mjs <test-glob> [...zones]
 */

import { spawnSync } from 'node:child_process';

const DEFAULT_ZONES = [
  'UTC',
  'Europe/London', // +00:00/+01:00 — DST
  'America/Los_Angeles', // -07:00/-08:00 — west of UTC, where "date-only as
  // an instant" renders a day early
  'Asia/Kolkata', // +05:30 — a half-hour offset
  'Pacific/Kiritimati', // +14:00 — the far side of the date line
];

const [target, ...zoneArgs] = process.argv.slice(2);
if (!target) {
  console.error('usage: node scripts/test-timezones.mjs <test-glob> [...zones]');
  process.exit(2);
}

const zones = zoneArgs.length > 0 ? zoneArgs : DEFAULT_ZONES;
let failed = 0;

for (const timeZone of zones) {
  const result = spawnSync(process.execPath, ['--test', target], {
    env: { ...process.env, TZ: timeZone },
    encoding: 'utf8',
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const pass = /^# pass (\d+)/m.exec(output)?.[1] ?? /ℹ pass (\d+)/.exec(output)?.[1] ?? '?';
  const fail = /^# fail (\d+)/m.exec(output)?.[1] ?? /ℹ fail (\d+)/.exec(output)?.[1] ?? '?';

  // Guard against the failure this script exists to prevent: if TZ did not
  // take effect, the matrix is a lie and must not report success.
  const reported = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)'],
    { env: { ...process.env, TZ: timeZone }, encoding: 'utf8' }
  ).stdout;

  // Node canonicalises some zone names (`Asia/Kolkata` reports back as
  // `Asia/Calcutta`), so compare the resolved OFFSET rather than the label —
  // an alias is fine, a silently ignored TZ is not.
  const offsetOf = (tz) =>
    spawnSync(
      process.execPath,
      ['-e', "process.stdout.write(String(new Date('2026-06-12T00:00:00Z').getTimezoneOffset()))"],
      { env: { ...process.env, TZ: tz }, encoding: 'utf8' }
    ).stdout;

  if (reported !== timeZone && offsetOf(timeZone) === offsetOf('UTC') && timeZone !== 'UTC') {
    console.error(`✖ ${timeZone}: TZ did not take effect (node reported "${reported}")`);
    failed += 1;
    continue;
  }

  if (result.status === 0) {
    console.log(`✔ ${timeZone}: ${pass} passed`);
  } else {
    console.error(`✖ ${timeZone}: ${fail} failed, ${pass} passed`);
    console.error(output);
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`\n${failed} timezone(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${zones.length} timezones passed.`);
