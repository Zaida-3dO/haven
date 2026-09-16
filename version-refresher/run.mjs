#!/usr/bin/env node
/**
 * The container-version refresher — a small sidecar that fills the gap the
 * read half (`server/src/container-versions.js`) has always tolerated but
 * nothing ever wrote: `docs/CONFIGURATION.md` describes
 * `config/container-versions.json` as "written by a refresher, not by
 * hand", and until this file, that refresher did not exist. The old
 * dashboard's equivalent (`get-versions.sh`) was run BY HAND over SSH —
 * there was no scheduler, which is the whole gap this closes.
 *
 * ## Why this is a separate container, not a Haven feature
 *
 * Reading Docker labels needs the Docker socket, and Haven is a web-facing
 * container that must never hold it — see `server/src/container-versions.js`'s
 * module doc and CLAUDE.md. So this lives in its own container, mounts the
 * socket **read-only**, and talks to Haven only through a shared file on the
 * `./config` volume. If this container is compromised, it can read
 * container metadata; it cannot reach the web.
 *
 * ## Why a sleep loop and not host cron
 *
 * `crontab` on this QNAP returns "must be suid to work properly" — host cron
 * is not available (see `.claude/memory/lessons-patrick-infrastructure.md`
 * in the Patrick workspace, and the item body for this task). Container-side
 * scheduling is the established pattern here, and a `sleep` loop is the
 * simplest version of it: no cron daemon to install, no extra dependency,
 * easy to read.
 *
 * ## Failure is loud in the logs, quiet in the file
 *
 * A pass that throws is caught, logged, and retried on the next tick rather
 * than crashing the container — a transient Docker daemon hiccup should not
 * need a manual restart. But it does NOT write a partial or error file: if a
 * pass fails, the existing file is left exactly as it was. That is
 * deliberate — see `container-versions.js`'s doc on why `generatedAt` is the
 * only thing that reveals a dead writer. A crashed container stops updating
 * the timestamp; that staleness IS the failure signal, and the read half
 * already surfaces it as `currentAsOf`. Inventing a fresher timestamp on a
 * failed pass would erase that signal.
 */

import { runPass, parseRoster } from './lib/refresh.mjs';
import { writeEnvelope } from './lib/write.mjs';

/**
 * The roster of containers to watch, and how to read each one's version
 * label. Configured via env rather than hardcoded (unlike the old script)
 * so the actual container names — which are not committed anywhere in this
 * public repo — live only in the deployment's `.env`.
 *
 * Format: `name:scheme,name:scheme,...` where scheme is `linuxserver` or
 * `oci`. See `.env.example` for the full explanation and a worked example.
 */
const ROSTER_SPEC = process.env.VERSION_REFRESHER_CONTAINERS ?? '';

/** Where to write the envelope. Mounted from the same host path as Haven's `./config` mount, but writable here. */
const OUTPUT_PATH = process.env.VERSION_REFRESHER_OUTPUT ?? '/app/config/container-versions.json';

/** How often to run a pass, in seconds. */
const INTERVAL_SECONDS = Number(process.env.VERSION_REFRESHER_INTERVAL_SECONDS ?? 300);

/** Override for the `docker` binary/path. Default is `docker` on PATH — see docker.mjs's module doc. */
const DOCKER_BIN = process.env.VERSION_REFRESHER_DOCKER_BIN || undefined;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick(roster) {
  try {
    const envelope = await runPass(roster, DOCKER_BIN ? { dockerBin: DOCKER_BIN } : {});
    writeEnvelope(OUTPUT_PATH, envelope);
    console.log(
      `[version-refresher] wrote ${Object.keys(envelope.versions).length} version(s) to ${OUTPUT_PATH} at ${envelope.generatedAt}`
    );
  } catch (err) {
    // Deliberately does not touch OUTPUT_PATH on failure — see module doc.
    console.error('[version-refresher] pass failed, leaving existing file untouched:', err);
  }
}

async function main() {
  const roster = parseRoster(ROSTER_SPEC);
  if (roster.length === 0) {
    console.warn(
      '[version-refresher] VERSION_REFRESHER_CONTAINERS is empty or unset — nothing to watch. See .env.example.'
    );
  }

  // Run once immediately on start, rather than waiting a full interval —
  // otherwise a container restart means the file's age climbs unnecessarily
  // before the first write.
  for (;;) {
    await tick(roster);
    await sleep(INTERVAL_SECONDS * 1000);
  }
}

main();
