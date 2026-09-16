/**
 * Pure label-parsing logic ported from the old dashboard's
 * `get-versions.sh` (`ssh Zevirdrah cat /share/Container/scripts/get-versions.sh`).
 *
 * The old script read one of two Docker labels depending on the image family:
 *
 *   - LinuxServer.io images set `build_version` to a verbose string like
 *     `Linuxserver.io version:- 1.2.3 Build-date:- 2026-08-01`, which the
 *     script stripped down to `1.2.3` with a `sed` pair.
 *   - OCI-labelled images set the standard `org.opencontainers.image.version`
 *     label to a bare version string already.
 *
 * This module ports both the label choice and the stripping, as pure
 * functions, so the behaviour can be unit tested without a Docker daemon.
 */

/** The two label schemes the old script understood, in the order it checked them. */
export const LABEL_SCHEMES = Object.freeze({
  LINUXSERVER: 'build_version',
  OCI: 'org.opencontainers.image.version',
});

/**
 * Strips the LinuxServer.io verbose prefix/suffix from a `build_version`
 * label value.
 *
 * Ports the old script's two-part `sed` exactly:
 *   s/Linuxserver\.io version:- //
 *   s/ Build-date:-.* / (removes everything from " Build-date:-" onward)
 *
 * A label that does not match either pattern (an OCI-style bare version, or
 * something unexpected) passes through unchanged — the old script's `sed`
 * is a no-op when its pattern does not match, and this preserves that.
 */
export function stripLinuxServerPrefix(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/Linuxserver\.io version:- /, '').replace(/ Build-date:-.*/, '');
}

/**
 * Picks the version string out of a container's Docker labels for a given
 * label scheme, applying the LinuxServer.io stripping when that scheme is
 * used.
 *
 * @param {Record<string, string>} labels the `.Config.Labels` object from
 *   `docker inspect`
 * @param {string} scheme one of `LABEL_SCHEMES`
 * @returns {string|null} a trimmed, non-empty version string, or null when
 *   the label is absent, empty, or not a string — the same "skip if version
 *   is empty" behaviour the old script had.
 */
export function extractVersion(labels, scheme) {
  if (!labels || typeof labels !== 'object') return null;
  const raw = labels[scheme];
  if (typeof raw !== 'string') return null;

  const stripped = scheme === LABEL_SCHEMES.LINUXSERVER ? stripLinuxServerPrefix(raw) : raw;
  const trimmed = stripped.trim();
  return trimmed ? trimmed : null;
}

/**
 * Builds the envelope shape `container-versions.js` (the read half) expects:
 *
 *   { "generatedAt": "<ISO8601>", "versions": { containerId: version } }
 *
 * `versions` only, never a bare map — the read half accepts both shapes, but
 * a purpose-built refresher should always emit the one that carries its own
 * age (see `server/src/container-versions.js`'s module doc).
 *
 * @param {Record<string, string|null>} versions containerName -> version,
 *   where a null/empty value means "skip this container" (not running, or no
 *   usable label) — filtered out here rather than by every caller.
 * @param {string} generatedAt ISO8601 timestamp string
 */
export function buildEnvelope(versions, generatedAt) {
  const clean = {};
  for (const [id, version] of Object.entries(versions ?? {})) {
    if (typeof version === 'string' && version.trim()) clean[id] = version.trim();
  }
  return { generatedAt, versions: clean };
}
