/**
 * Docker-inspecting side of the refresher — the part that actually shells
 * out. Kept thin and injectable (`execFileFn`) so `lib/labels.mjs` carries
 * the logic worth unit testing and this stays a thin, mockable adapter.
 *
 * Ports `get-versions.sh`'s two docker calls per container:
 *   1. `docker ps --filter "name=^/${NAME}$" --format "{{.Names}}"` — is it
 *      running at all? A stopped or absent container is skipped, not an
 *      error.
 *   2. `docker inspect --format '{{ index .Config.Labels "<LABEL>" }}' NAME`
 *      — the label read.
 *
 * The two calls are kept separate (rather than a single `inspect` and
 * checking `.State.Running`) to stay a faithful, easily-diffed port of the
 * original script's behaviour.
 *
 * ## Why the default binary is just `docker`, not the QNAP's own path
 *
 * `get-versions.sh` ran directly on the QNAP host, so it needed the QNAP's
 * own binary at `/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker` —
 * a symlink into QNAP's own wrapper, tied to QNAP's shared libraries. This
 * refresher instead runs INSIDE a container that talks to the daemon over
 * the mounted socket, with a standard `docker-ce-cli` install (see the
 * Dockerfile) — so the portable default is the CLI on `PATH`, exactly as it
 * would be on any other Docker host. `VERSION_REFRESHER_DOCKER_BIN` remains
 * an override for anyone running this outside that container.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Default docker binary — resolved from PATH inside the refresher's own container. */
export const DEFAULT_DOCKER_BIN = 'docker';

/**
 * Whether a container by this exact name is currently running.
 *
 * The `^/${name}$` anchor matches the old script's filter exactly — Docker
 * container names are stored with a leading slash internally, and the
 * anchors stop "plex" from also matching a hypothetical "plex-old".
 */
export async function isRunning(
  name,
  { dockerBin = DEFAULT_DOCKER_BIN, execFileFn = execFileAsync } = {}
) {
  try {
    const { stdout } = await execFileFn(dockerBin, [
      'ps',
      '--filter',
      `name=^/${name}$`,
      '--format',
      '{{.Names}}',
    ]);
    return stdout.trim() === name;
  } catch {
    // docker unreachable, container-station down, etc: treat as not running
    // rather than throwing — one bad container should not abort the batch.
    return false;
  }
}

/**
 * Reads one label off a container's `.Config.Labels`, exactly as
 * `docker inspect --format '{{ index .Config.Labels "<LABEL>" }}'` would.
 *
 * Returns the raw label string (possibly empty), or null if the inspect
 * call itself failed (container gone, docker unreachable).
 */
export async function inspectLabel(
  name,
  label,
  { dockerBin = DEFAULT_DOCKER_BIN, execFileFn = execFileAsync } = {}
) {
  try {
    const { stdout } = await execFileFn(dockerBin, [
      'inspect',
      '--format',
      `{{ index .Config.Labels "${label}" }}`,
      name,
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}
