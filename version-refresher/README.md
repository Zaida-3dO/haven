# version-refresher

The write half of Haven's container-version feature. Haven's server
(`server/src/container-versions.js`, `server/src/routes/versions.js`) reads
`config/container-versions.json` to show a "current" version beside each
app's "latest" release. This is the small sidecar that writes that file.

**Full design and reasoning:** `run.mjs`'s module doc, and
`docs/CONFIGURATION.md`'s `config/container-versions.json` section.

## Why a separate container

Reading a running container's version needs the Docker socket. Haven is a
web-facing container and must never hold that access — see
`container-versions.js`'s module doc and the repo's `CLAUDE.md`. So this
lives in its own container: it mounts the socket **read-only**, writes a
small JSON file to the same host directory Haven mounts (`./config`, but
writable on this side), and nothing else connects the two.

## How it works

1. Reads its roster from `VERSION_REFRESHER_CONTAINERS`
   (`name:scheme,name:scheme,...` — see `.env.example`).
2. For each container: checks it is running (`docker ps --filter`), then
   reads the relevant Docker label (`build_version` for LinuxServer.io
   images, `org.opencontainers.image.version` for OCI ones), stripping the
   LinuxServer.io verbose prefix/suffix. This logic is ported from the old
   dashboard's `get-versions.sh`, which was run by hand over SSH — see
   `lib/labels.mjs` and `lib/docker.mjs`.
3. Writes `{"generatedAt": "<ISO8601>", "versions": {name: version}}` to
   `VERSION_REFRESHER_OUTPUT` (default `/app/config/container-versions.json`,
   the exact envelope shape `container-versions.js` expects).
4. Sleeps `VERSION_REFRESHER_INTERVAL_SECONDS` (default 300) and repeats,
   forever — this is the scheduler. **Not host cron**: `crontab` on the QNAP
   this deploys to returns "must be suid to work properly", so host cron is
   unavailable, and container-side scheduling is the established pattern
   here.

## Failure mode

A failed pass (Docker unreachable, a container gone) is logged and retried
next tick — it does **not** touch the output file. If the whole container
dies, the file simply stops changing. That staleness is the only signal, by
design: the read half surfaces the file's `generatedAt` as `currentAsOf`
specifically so a dead refresher is visible rather than silently serving a
plausible-looking but stale version forever.

## Running the tests

```bash
npm run test:refresher    # from the repo root
```

`test/contract.test.js` is the one worth reading first: it feeds this
package's own output into the ACTUAL read half
(`server/src/container-versions.js`), not a re-description of its shape, so
it is the test that would fail if the two sides of this feature drifted
apart.

## Configuration

See `.env.example`'s "Container-version refresher" section and
`docker-compose.yml`'s `version-refresher` service.
