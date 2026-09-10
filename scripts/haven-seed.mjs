#!/usr/bin/env node
/**
 * Seeds a whole Haven dashboard from one declarative file, and reads one back.
 *
 * SHIP THE SCRIPT, NEVER YOUR SEED FILE. The same warning that heads
 * `migrate-apps.mjs` applies with more force here, because this file describes
 * MORE of the network than the app registry alone: every service URL, every
 * widget's configured endpoint, every calendar. `config/*.json` is gitignored
 * for exactly this reason — keep your real dashboard file there, and commit
 * only `config/dashboard.example.json`. See docs/SECURITY.md.
 *
 * Usage:
 *   node scripts/haven-seed.mjs apply  --file dashboard.json --base-url http://localhost:8480
 *   node scripts/haven-seed.mjs apply  --file dashboard.json --dry-run
 *   node scripts/haven-seed.mjs export --out dashboard.json  --base-url http://localhost:8480
 *
 * Exit codes: 0 success, 1 a failure the report names.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { applySeed, baseDirOf, exportSeed } from './lib/seed-apply.mjs';
import { createClient } from './lib/seed-client.mjs';

const DEFAULT_BASE_URL = 'http://localhost:8480';

export function parseArgs(argv) {
  const args = {
    command: null,
    file: null,
    out: null,
    baseUrl: process.env.HAVEN_BASE_URL || DEFAULT_BASE_URL,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file' || arg === '-f') args.file = argv[++i];
    else if (arg === '--out' || arg === '-o') args.out = argv[++i];
    else if (arg === '--base-url') args.baseUrl = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (!arg.startsWith('-') && !args.command) args.command = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

const HELP = `
Seeds a Haven dashboard from one declarative file, and reads one back.

  apply   --file <path>   apply a seed file to a running Haven
  export  --out <path>    read a running Haven into a seed file (- for stdout)

  --base-url <url>  Haven's address (default ${DEFAULT_BASE_URL}, or $HAVEN_BASE_URL)
  --dry-run         apply only: report what would change, change nothing
  --help            this text

The seed file has three sections — apps, instances, layout — and is documented
in docs/CONFIGURATION.md. An example lives at config/dashboard.example.json.

NEVER commit a real seed file: it maps your internal network. Keep it in
config/ (gitignored) and commit only the .example.json.
`;

/**
 * Prints the per-item report.
 *
 * Grouped by outcome rather than by section, because the question a reader
 * actually has after a run is "did anything fail and what", not "what
 * happened to the apps". Failures come LAST so they are the thing left on
 * screen.
 */
export function formatReport(result) {
  const lines = [];
  const by = (action) => result.results.filter((r) => r.action === action);

  const section = (label, rows) => {
    if (!rows.length) return;
    lines.push(`\n${label} (${rows.length}):`);
    for (const row of rows) {
      lines.push(`  ${row.kind} ${row.id}${row.detail ? ` — ${row.detail}` : ''}`);
    }
  };

  if (result.dryRun) {
    lines.push('DRY RUN — nothing was changed.');
    section('Would create', by('would create'));
    section('Would update', by('would update'));
    section('Would upload', by('would upload'));
  } else {
    section('Created', by('created'));
    section('Updated', by('updated'));
    section('Uploaded', by('uploaded'));
  }

  section('Skipped (already matching)', by('skipped'));
  section('FAILED', by('failed'));

  const counts = result.results.reduce((acc, r) => {
    acc[r.action] = (acc[r.action] ?? 0) + 1;
    return acc;
  }, {});
  lines.push(
    `\n${Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')}.`
  );

  // The migration report only matters when the file was in the old shape;
  // staying silent otherwise keeps a normal run readable.
  const m = result.migration;
  if (m?.unknown?.length) {
    lines.push(`\nUNKNOWN fields in the old-shape input — not mapped, check these:`);
    for (const item of m.unknown) lines.push(`  - ${item}`);
  }
  if (m?.skipped?.length) {
    lines.push(`\nEntries skipped by the old-shape mapping:`);
    for (const item of m.skipped) lines.push(`  - ${item}`);
  }

  return lines.join('\n');
}

export async function main(argv, { log = console.log, error = console.error } = {}) {
  const args = parseArgs(argv);

  if (args.help || !args.command) {
    log(HELP);
    return args.help ? 0 : 1;
  }

  const client = createClient({ baseUrl: args.baseUrl });

  if (args.command === 'apply') {
    if (!args.file) {
      error('apply needs --file <path>.');
      return 1;
    }

    const doc = JSON.parse(await readFile(args.file, 'utf8'));
    const result = await applySeed({
      client,
      doc,
      baseDir: baseDirOf(args.file),
      dryRun: args.dryRun,
    });

    log(formatReport(result));
    return result.ok ? 0 : 1;
  }

  if (args.command === 'export') {
    const doc = await exportSeed(client);
    const json = `${JSON.stringify(doc, null, 2)}\n`;

    if (!args.out || args.out === '-') {
      log(json);
    } else {
      await writeFile(args.out, json, 'utf8');
      error(
        `Wrote ${args.out} — ${doc.apps.length} app(s), ${doc.instances.length} instance(s). ` +
          `Do NOT commit it: it maps your internal network.`
      );
    }
    return 0;
  }

  error(`Unknown command "${args.command}". Expected: apply, export.`);
  return 1;
}

// Only run when invoked directly, so the pieces can be imported by tests —
// the same guard `migrate-apps.mjs` uses.
//
// `process.exitCode` rather than `process.exit()`, deliberately. `fetch`'s
// underlying sockets are still closing when the last await resolves, and
// calling `process.exit()` on top of them aborts the process from inside libuv
// (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`) with status 127 —
// on a run that SUCCEEDED. That would be worse than cosmetic: the one thing a
// script wrapping this tool reads is the exit status, so a successful seed
// reporting 127 breaks exactly the automation the tool exists for. Setting the
// code and letting Node exit on its own drains the sockets first.
if (process.argv[1] && process.argv[1].endsWith('haven-seed.mjs')) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`Seed failed: ${err.message}`);
      process.exitCode = 1;
    }
  );
}
