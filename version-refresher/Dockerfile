# The container-version refresher — a small sidecar, deliberately separate
# from the main Haven image. See run.mjs's module doc for why: it needs the
# Docker socket, and the web-facing Haven container must never hold one.
#
# No native deps, no build step: this is a handful of dependency-free `.mjs`
# files that only touch `node:fs` and `node:child_process`, so a single slim
# stage is enough — apart from the `docker` CLI itself, which this image
# installs from Docker's own apt repo rather than bind-mounting the host
# binary. The QNAP's own `/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker`
# is a symlink into `/lib/container-station/wrapper/`, tied to QNAP's shared
# libraries — it will not run inside an arbitrary container's filesystem. The
# CLI only needs to be ABI-compatible with the daemon it talks to over the
# socket, so a standard `docker-ce-cli` package is the portable choice.

FROM node:24-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

COPY version-refresher/ ./version-refresher/

ARG APP_VERSION=dev
LABEL org.opencontainers.image.version="${APP_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/Zaida-3dO/haven"
LABEL org.opencontainers.image.description="Container-version refresher sidecar for Haven's apps widget."
LABEL org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production

# Runs as root deliberately: reading the Docker socket generally requires it
# (or membership in the host's `docker` group, which does not map cleanly
# into a container's own UID namespace). This is exactly the escalation
# CLAUDE.md and container-versions.js's module doc describe — it is why this
# lives in its own container instead of inside Haven, which runs as `node`
# and holds no such access.
ENTRYPOINT ["node", "version-refresher/run.mjs"]
