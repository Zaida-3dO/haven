/**
 * One refresh pass: walk the configured containers, resolve each one's
 * running version, and write the envelope Haven's read half
 * (`server/src/container-versions.js`) expects.
 *
 * Kept separate from `run.mjs` (the scheduler/entrypoint) so a pass can be
 * driven directly in tests with fake `docker` and `fs` adapters, with no
 * process, socket or timer involved.
 */

import { LABEL_SCHEMES, buildEnvelope, extractVersion } from './labels.mjs';
import { inspectLabel, isRunning } from './docker.mjs';

/**
 * Parses the container roster from its env-var encoding:
 *
 *   CONTAINER_NAME:label_scheme,CONTAINER_NAME:label_scheme,...
 *
 * where `label_scheme` is `linuxserver` or `oci`. This mirrors the old
 * script's hardcoded `emit_entry` calls, made configurable instead of
 * hardcoded so the roster lives in `.env` (deployment-side config) rather
 * than in a file this public repo tracks — see CLAUDE.md's rule against
 * committing anything that maps the internal network. Container *names* are
 * not network topology (no IP, no hostname, no port), but keeping the full
 * roster out of tracked source is the more conservative reading.
 *
 * A malformed entry (missing scheme, unknown scheme) is skipped with a
 * warning rather than aborting the whole batch — a typo in one entry
 * should not blind the refresher to every other container.
 *
 * @returns {Array<{name: string, scheme: string}>}
 */
export function parseRoster(spec, { warn = console.warn } = {}) {
  if (typeof spec !== 'string' || !spec.trim()) return [];

  const scheme = (token) => {
    const normalised = token.trim().toLowerCase();
    if (normalised === 'linuxserver') return LABEL_SCHEMES.LINUXSERVER;
    if (normalised === 'oci') return LABEL_SCHEMES.OCI;
    return null;
  };

  const roster = [];
  for (const entry of spec.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const [name, schemeToken] = trimmed.split(':');
    const resolvedScheme = schemeToken ? scheme(schemeToken) : null;

    if (!name || !resolvedScheme) {
      warn?.(
        `[version-refresher] skipping malformed roster entry "${trimmed}" — expected "name:linuxserver" or "name:oci"`
      );
      continue;
    }

    roster.push({ name: name.trim(), scheme: resolvedScheme });
  }
  return roster;
}

/**
 * Runs one full pass over the roster and returns the envelope object ready
 * to be written to disk (JSON.stringify'd by the caller).
 *
 * @param {Array<{name: string, scheme: string}>} roster
 * @param {object} [deps]
 * @param {(name: string, opts: object) => Promise<boolean>} [deps.isRunningFn]
 * @param {(name: string, label: string, opts: object) => Promise<string|null>} [deps.inspectLabelFn]
 * @param {string} [deps.dockerBin]
 * @param {() => string} [deps.now] returns an ISO8601 timestamp
 */
export async function runPass(roster, deps = {}) {
  const {
    isRunningFn = isRunning,
    inspectLabelFn = inspectLabel,
    dockerBin,
    now = () => new Date().toISOString(),
  } = deps;

  const opts = dockerBin ? { dockerBin } : {};
  const results = {};

  for (const entry of roster) {
    // Sequential rather than Promise.all: this runs unattended, so a
    // handful of extra seconds on a slow NAS is a far better trade than N
    // concurrent `docker` child processes competing for the same daemon.
    const running = await isRunningFn(entry.name, opts);
    if (!running) continue;

    const raw = await inspectLabelFn(entry.name, entry.scheme, opts);
    const version = extractVersion({ [entry.scheme]: raw }, entry.scheme);
    if (version) results[entry.name] = version;
  }

  return buildEnvelope(results, now());
}
