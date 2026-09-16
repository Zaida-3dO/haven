/**
 * Writes the envelope to disk atomically.
 *
 * Atomic because Haven's read half (`server/src/container-versions.js`)
 * reads this file at request time, on its own schedule, with no
 * coordination with the writer. A direct `writeFileSync` can be observed
 * mid-write by a concurrent reader on some filesystems; write-to-temp-then-
 * rename is the standard fix, and `rename` is atomic on the same
 * filesystem, which a sibling file in the same directory always is.
 */

import { renameSync, writeFileSync } from 'node:fs';

export function writeEnvelope(path, envelope) {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), 'utf8');
  renameSync(tmpPath, path);
}
