/**
 * The running-container version map, read from a file at request time.
 *
 * ## Why a file and not the Docker socket
 *
 * The apps widget draws a **running** version beside the **latest** release.
 * The old dashboard answered "what is running" by shelling out to the Docker
 * socket. Haven does not mount that socket and deliberately never will —
 * handing a web-facing container root-equivalent access to the host is a bad
 * trade for displaying a string.
 *
 * So something *else* holds the socket, writes a small JSON file, and Haven
 * reads it. The escalation stays out of the web-facing container; the web-
 * facing container reads a file off a read-only mount, which is a thing it
 * already does twice (`config/apps.json`, `config/settings.json`).
 *
 * ## Why the read is at REQUEST time and not at boot
 *
 * `config.js` is evaluated once, when the module graph is first imported. A
 * version map read there would be frozen for the life of the process, so every
 * container upgrade would need a Haven restart before the number changed —
 * which is exactly the drift this replaces. `HAVEN_CONTAINER_VERSIONS` already
 * has that problem; a file read once at boot would have it too, just with an
 * extra file in the way.
 *
 * So the read happens per request, behind a short TTL. The TTL exists only to
 * keep a burst of cards from stat-ing the same file dozens of times; it is
 * seconds, not hours, so a refresher writing the file is visible almost
 * immediately.
 *
 * ## Why the timestamp is not optional
 *
 * The failure mode of this design is a **dead refresher**: the file stops
 * being updated and Haven goes on serving whatever it last said, confidently
 * and wrongly. That is the same lie as a stale env map, only automated and
 * therefore harder to notice.
 *
 * The defence is that every read carries a `generatedAt`, and the UI shows it.
 * A version display that cannot be checked for staleness is worse than no
 * version display, so the timestamp travels with the data rather than being a
 * separate diagnostic nobody looks at.
 *
 * ## Failure is always quiet
 *
 * Missing file, unreadable file, malformed JSON, wrong shape: all degrade to
 * "no versions from the file", which falls back to the env map, which falls
 * back to `null`, which the card renders as an em dash. Nothing here can stop
 * the server booting or fail a request — the same discipline as
 * `loadSettings()` and `seedApps()`.
 */

import { readFileSync, statSync } from 'node:fs';

/**
 * How long a read is reused before the file is consulted again.
 *
 * Short on purpose. This is a de-duplication window for the fan-out of one
 * dashboard refresh (the apps widget resolves every card in a single request),
 * NOT a cache in the "releases change on the order of weeks" sense that
 * governs the GitHub lookups. A newly written file becomes visible within a
 * minute without anyone restarting anything.
 */
export const VERSIONS_FILE_TTL_MS = 60_000;

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Keeps only `containerId -> version` string pairs.
 *
 * A file written by some other process is untrusted input: a nested object or
 * a number where a version string was expected must be dropped, not rendered.
 */
function stringValuesOnly(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}

/**
 * Reads and normalises the versions file.
 *
 * Two shapes are accepted:
 *
 *   `{ "generatedAt": "<ISO>", "versions": { id: version } }` — the shape a
 *   purpose-built refresher should write, because it carries its own age.
 *
 *   `{ id: version }` — a bare map. The old dashboard's `get-versions.sh`
 *   already emits exactly this, so accepting it means that script can be
 *   pointed at the mount unchanged rather than needing a translation step.
 *   Its age comes from the file's mtime instead, which is very nearly as good
 *   and requires nothing of the writer.
 *
 * The envelope is detected by the presence of a `versions` OBJECT — not by
 * `generatedAt`, which a writer may legitimately omit. A bare map with a
 * container literally called `versions` mapping to a string still reads as a
 * bare map, because the value is not an object.
 *
 * @returns {{versions: object, generatedAt: string|null}|null} null when the
 *   file gave us nothing usable.
 */
function readVersionsFile(path, logger) {
  let text;
  let mtime;

  try {
    text = readFileSync(path, 'utf8');
    try {
      mtime = statSync(path).mtime.toISOString();
    } catch {
      // An unreadable stat on a readable file is not worth failing over; the
      // envelope shape may carry its own timestamp anyway.
      mtime = null;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // Bad permissions, a directory where a file was expected: say so, once.
      logger?.warn?.({ path, err: error }, 'could not read container versions file');
    }
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    logger?.warn?.({ path, err: error }, 'container versions file is not valid JSON — ignoring');
    return null;
  }

  if (!isPlainObject(parsed)) {
    logger?.warn?.({ path }, 'container versions file is not an object — ignoring');
    return null;
  }

  if (isPlainObject(parsed.versions)) {
    const generatedAt = typeof parsed.generatedAt === 'string' ? parsed.generatedAt : mtime;
    return { versions: stringValuesOnly(parsed.versions), generatedAt: generatedAt ?? null };
  }

  return { versions: stringValuesOnly(parsed), generatedAt: mtime };
}

/**
 * A request-time reader for the versions file, with its own TTL and cache.
 *
 * Built as an object rather than module-level state so tests can hold several
 * independent readers with an injected clock, and so the server owns one
 * explicitly instead of sharing a hidden global.
 *
 * @param {object} [opts]
 * @param {string} [opts.path] file to read
 * @param {number} [opts.ttlMs] reuse window
 * @param {object} [opts.logger] Fastify-style logger
 * @param {() => number} [opts.now] injectable clock, for tests
 */
export function createContainerVersionsReader({
  path,
  ttlMs = VERSIONS_FILE_TTL_MS,
  logger,
  now = Date.now,
} = {}) {
  /** @type {{versions: object, generatedAt: string|null}|null} */
  let cached = null;
  let readAt = -Infinity;

  /**
   * Whether we have already complained about this file.
   *
   * A malformed file stays malformed until someone fixes it, and the read is
   * per request — so without this, one bad file writes a warning line for
   * every card on every dashboard refresh, forever. The brief asks for the
   * warning once. Reset whenever a read succeeds, so a file that breaks again
   * later is reported again.
   */
  let warned = false;

  const quietLogger = logger && {
    warn: (...args) => {
      if (warned) return;
      warned = true;
      logger.warn?.(...args);
    },
  };

  return {
    /**
     * The current file contents, re-read when the TTL has expired.
     *
     * Returns `{ versions, generatedAt }` — `versions` is always an object so
     * callers can index it without a guard, and `generatedAt` is null when the
     * file is absent or unusable.
     */
    read() {
      if (!path) return { versions: {}, generatedAt: null };

      const at = now();
      if (cached !== null && at - readAt < ttlMs) return cached;

      const fresh = readVersionsFile(path, quietLogger);
      if (fresh) warned = false;

      cached = fresh ?? { versions: {}, generatedAt: null };
      readAt = at;
      return cached;
    },
  };
}
