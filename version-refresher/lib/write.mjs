/**
 * Writes the envelope to disk atomically, and world-readable.
 *
 * Atomic because Haven's read half (`server/src/container-versions.js`)
 * reads this file at request time, on its own schedule, with no
 * coordination with the writer. A direct `writeFileSync` can be observed
 * mid-write by a concurrent reader on some filesystems; write-to-temp-then-
 * rename is the standard fix, and `rename` is atomic on the same
 * filesystem, which a sibling file in the same directory always is.
 *
 * ## Why the explicit mode, and why chmod after the write
 *
 * The writer and the reader are different containers running as DIFFERENT
 * USERS: this sidecar runs as root (it needs the Docker socket), while Haven
 * runs as `node`. They share only the `./config` bind mount. With no explicit
 * mode the file is created under root's umask — observed as `rw-rw----
 * root:root` on the QNAP — and Haven's `node` user gets "permission denied"
 * reading it. The symptom is silent and misleading: the refresher logs a
 * successful write every pass, the file is visibly correct on the host, and
 * the dashboard still shows no current version, because the read half
 * degrades quietly on an unreadable file exactly as it does on a missing one.
 *
 * `writeFileSync`'s `mode` option is masked by the process umask, so it
 * cannot be relied on alone — a umask of 0027 turns a requested 0644 into
 * 0640, which is the failure above. `chmodSync` is not masked, so the mode is
 * set explicitly on the temp file BEFORE the rename: renaming a
 * correctly-moded file into place keeps the swap atomic, whereas chmod-ing
 * after the rename would leave a window where a reader sees the new file
 * still unreadable.
 *
 * 0644 rather than something tighter because this file holds no secrets —
 * it is a map of container names to version strings, the same information
 * `docker ps` prints. The container names are mildly topological, which is
 * why they live in the deployment's `.env` and not in this repo, but the
 * file itself sits inside a bind mount only these two containers share.
 */

import { chmodSync, renameSync, writeFileSync } from 'node:fs';

/** Readable by any user in the container, writable only by the owner. */
const FILE_MODE = 0o644;

export function writeEnvelope(path, envelope) {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), 'utf8');
  // Not masked by umask, unlike writeFileSync's own `mode` option — and done
  // before the rename so the file is never visible at `path` unreadable.
  chmodSync(tmpPath, FILE_MODE);
  renameSync(tmpPath, path);
}
