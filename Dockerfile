# ── Stage 1: build the web shell ─────────────────────────────────────────
FROM node:24-slim AS web-build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY web/package.json web/
COPY server/package.json server/

# Only the web workspace is built in this stage, so only its dependencies are
# installed. `--workspace=web` alone is not enough: npm still resolves the
# whole tree, so better-sqlite3 — a native module belonging to the server —
# lands in a stage that deliberately has no python3/make/g++, and the build
# dies in node-gyp. `--ignore-scripts` is the belt to that braces: nothing in
# a front-end build should be running an install script.
RUN npm install --workspace=web --include-workspace-root \
    --ignore-scripts --no-audit --no-fund --prefer-offline

COPY web/ web/
RUN npm run build --workspace=web

# ── Stage 2: production dependencies only ────────────────────────────────
FROM node:24-slim AS deps
WORKDIR /app

# better-sqlite3 is a native module — it needs a toolchain to build if no
# prebuilt binary matches this platform.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install --omit=dev --workspace=server --no-audit --no-fund

# ── Stage 3: runtime ─────────────────────────────────────────────────────
FROM node:24-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# npm workspaces hoist every dependency to the ROOT node_modules, so there is
# no server/node_modules to copy — Node resolves the server's imports by
# walking up from server/src/ to /app/node_modules.
COPY --from=deps /app/node_modules ./node_modules
COPY server/ ./server/
COPY --from=web-build /app/web/dist ./web/dist
COPY package.json ./

# The seeding and migration CLIs, which docs/CONFIGURATION.md tells people to
# run — `docker exec haven node scripts/haven-seed.mjs …` is the realistic path
# for a fresh install, and it 404'd on a real deployment because the image did
# not carry them.
#
# The WHOLE directory, not a hand-picked subset: `haven-seed.mjs` imports
# `lib/seed-apply.mjs`, which in turn imports `../migrate-apps.mjs` for the
# old-schema mapping. Copying only `haven-seed.mjs` + `lib/` is exactly the
# partial copy that died with ERR_MODULE_NOT_FOUND when this was worked around
# by hand. They are a handful of dependency-free .mjs files.
#
# `scripts/check-image-contents.sh` asserts this stayed true.
COPY scripts/ ./scripts/

ARG APP_VERSION=dev
LABEL org.opencontainers.image.version="${APP_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/Zaida-3dO/haven"
LABEL org.opencontainers.image.description="A widget-based, self-hosted personal dashboard."
LABEL org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    HAVEN_HOST=0.0.0.0 \
    HAVEN_PORT=8080 \
    HAVEN_DB_PATH=/data/haven.db \
    HAVEN_VERSION="${APP_VERSION}"

# The SQLite file and uploaded icons live on a mounted volume, never in
# the image.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HAVEN_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/src/index.js"]
