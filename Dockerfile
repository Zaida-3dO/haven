# ── Stage 1: build the web shell ─────────────────────────────────────────
FROM node:24-slim AS web-build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm install --no-audit --no-fund --prefer-offline

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
