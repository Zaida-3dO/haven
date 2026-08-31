#!/usr/bin/env node
/**
 * Migrates the old dashboard's `apps.json` into the Haven app registry format.
 *
 * SHIP THE SCRIPT, NEVER ITS OUTPUT. The real registry maps the internal
 * network — every LAN address, internal hostname and port on it. The output
 * belongs in `config/`, which is gitignored for exactly this reason. Test
 * against a fixture built from `config/apps.example.json`; never against the
 * real file, and never commit what comes out. See docs/SECURITY.md.
 *
 * Usage:
 *   node scripts/migrate-apps.mjs --in <old-apps.json> --out config/apps.json
 *   node scripts/migrate-apps.mjs --in <old-apps.json> --dry-run
 *
 * Idempotent: running it twice over the same input produces the same output,
 * and re-running it over its OWN output is a no-op rather than a double
 * migration — already-migrated entries are detected and passed through.
 */

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Old field to secondary title, in PROBE PRIORITY ORDER.
 *
 * This ordering is the whole point of the migration: `web/src/lib/reachability.js`
 * walks `urls` in order and stops at the first host that answers, so the array
 * order decides which URL a click actually lands on. The old dashboard
 * hard-coded this same sequence (local alias, then local IP, then remote, then
 * Tailscale); here it becomes data.
 */
const SECONDARY_ORDER = [
  ['localUrl', 'Open Local'],
  ['localIpUrl', 'Open Local via IP'],
  ['remoteUrl', 'Open Remote'],
  ['tailscaleUrl', 'Open via Tailscale'],
];

/** Categories carried over unchanged. */
const CATEGORIES = new Set(['personal', 'media', 'home', 'ai', 'tools']);

/** Old fields this script knows about. Anything else is reported, not dropped silently. */
const KNOWN_FIELDS = new Set([
  'id',
  'name',
  'description',
  'category',
  'icon',
  'url',
  'localUrl',
  'localIpUrl',
  'remoteUrl',
  'tailscaleUrl',
  'releasesUrl',
  'containerId',
  'featured',
]);

/** Fields deliberately dropped — docs/DESIGN.md §6.2 lists these as removed. */
const DROPPED_FIELDS = new Set(['restartUrl', 'rooms']);

export function parseArgs(argv) {
  const args = { in: null, out: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--in') args.in = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

/** An entry already in the new shape — i.e. re-running over our own output. */
function isAlreadyMigrated(app) {
  return Array.isArray(app?.urls);
}

/**
 * Builds the ordered `urls` array for one app.
 *
 * Two separate concerns that are easy to conflate:
 *
 *  - ORDER is probe priority. The local alias leads, matching the old
 *    `localUrl || url` precedence, because that is what answers first at home.
 *  - PRIMARY is the canonical address and the fallback when nothing answers.
 *    It rides on `url` wherever that lands in the probe order, rather than
 *    always being first.
 *
 * De-duplicated by URL: several old fields often held the same address, and a
 * duplicate would mean probing the same dead host twice.
 */
function buildUrls(app, report) {
  const urls = [];
  const seen = new Set();
  const canonical = typeof app.url === 'string' && app.url.trim() ? app.url.trim() : null;

  const push = (title, rawUrl, primary) => {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return;
    const url = rawUrl.trim();
    if (seen.has(url)) {
      report.deduped.push(`${app.id}: "${title}" duplicates an earlier URL`);
      return;
    }
    seen.add(url);
    urls.push(primary ? { title, url, primary: true } : { title, url });
  };

  for (const [field, title] of SECONDARY_ORDER) {
    push(title, app[field], app[field]?.trim?.() === canonical);
  }

  // The canonical `url`, if it was not already emitted as one of the variants
  // above. It goes first: with no localUrl there is nothing higher-priority.
  if (canonical && !seen.has(canonical)) {
    urls.unshift({ title: 'Open', url: canonical, primary: true });
    seen.add(canonical);
  }

  // The registry's validator requires exactly one primary. If there was no
  // canonical URL at all, promote the highest-priority variant.
  if (urls.length && !urls.some((u) => u.primary)) {
    urls[0] = { ...urls[0], primary: true };
    report.promoted.push(`${app.id}: no canonical url, promoted "${urls[0].title}" to primary`);
  }

  return urls;
}

function migrateApp(app, index, report) {
  if (!app?.id) {
    report.skipped.push(`entry ${index}: no id`);
    return null;
  }

  if (isAlreadyMigrated(app)) {
    report.alreadyMigrated.push(app.id);
    return app;
  }

  for (const key of Object.keys(app)) {
    if (DROPPED_FIELDS.has(key)) {
      report.dropped.push(`${app.id}: ${key} (deliberately removed)`);
    } else if (!KNOWN_FIELDS.has(key)) {
      // Reported rather than silently discarded — an unknown field is either a
      // new one worth mapping or a typo worth seeing.
      report.unknown.push(`${app.id}: ${key}`);
    }
  }

  const urls = buildUrls(app, report);
  if (!urls.length) {
    report.skipped.push(`${app.id}: no usable URLs`);
    return null;
  }

  const category = CATEGORIES.has(app.category) ? app.category : 'tools';
  if (!CATEGORIES.has(app.category)) {
    report.recategorised.push(`${app.id}: "${app.category ?? '(none)'}" to tools`);
  }

  const version = {};
  if (typeof app.releasesUrl === 'string' && app.releasesUrl.trim()) {
    version.latestUrl = app.releasesUrl.trim();
  }
  if (typeof app.containerId === 'string' && app.containerId.trim()) {
    version.currentContainerId = app.containerId.trim();
  }

  report.migrated.push(app.id);

  return {
    id: app.id,
    name: app.name ?? app.id,
    description: app.description ?? '',
    category,
    icon: app.icon ?? null,
    urls,
    ...(Object.keys(version).length ? { version } : {}),
  };
}

/**
 * Maps a whole old registry.
 *
 * Exported so the mapping can be unit-tested against a fixture without
 * touching the filesystem or the real registry.
 */
export function migrateRegistry(input) {
  const report = {
    migrated: [],
    alreadyMigrated: [],
    skipped: [],
    dropped: [],
    unknown: [],
    deduped: [],
    promoted: [],
    recategorised: [],
  };

  const source = Array.isArray(input) ? input : (input?.apps ?? []);
  const apps = source.map((app, i) => migrateApp(app, i, report)).filter(Boolean);

  return { output: { version: 1, apps }, report };
}

function printReport(report, { total, dryRun, out }) {
  const section = (label, items) => {
    if (!items.length) return;
    console.log(`\n${label} (${items.length}):`);
    for (const item of items) console.log(`  - ${item}`);
  };

  console.log(`Read ${total} app(s).`);
  console.log(`Migrated: ${report.migrated.length}`);

  section('Already in the new format, passed through', report.alreadyMigrated);
  section('Skipped', report.skipped);
  section('Dropped fields', report.dropped);
  section('UNKNOWN fields - not mapped, check these', report.unknown);
  section('Duplicate URLs removed', report.deduped);
  section('Primary promoted', report.promoted);
  section('Category fell back to "tools"', report.recategorised);

  console.log(
    dryRun ? '\nDry run - nothing written.' : `\nWrote ${out}. Do NOT commit it (gitignored).`
  );
}

const HELP = `
Migrates the old dashboard's apps.json into the Haven registry format.

  --in <path>    old apps.json to read
  --out <path>   where to write the new registry (gitignored; never commit it)
  --dry-run      report what would happen, write nothing

Never point --out anywhere git tracks. See docs/SECURITY.md.
`;

export function main(argv) {
  const args = parseArgs(argv);

  if (args.help || !args.in) {
    console.log(HELP);
    return args.help ? 0 : 1;
  }
  if (!args.out && !args.dryRun) {
    console.error('--out is required unless --dry-run is given.');
    return 1;
  }

  const input = JSON.parse(readFileSync(args.in, 'utf8'));
  const total = (Array.isArray(input) ? input : (input?.apps ?? [])).length;
  const { output, report } = migrateRegistry(input);

  if (!args.dryRun) {
    writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  }

  printReport(report, { total, dryRun: args.dryRun, out: args.out });
  return 0;
}

// Only run when invoked directly, so the mapping can be imported by tests.
if (process.argv[1] && process.argv[1].endsWith('migrate-apps.mjs')) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`Migration failed: ${err.message}`);
    process.exit(1);
  }
}
