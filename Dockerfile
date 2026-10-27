# syntax=docker/dockerfile:1

# Node.js 24 LTS on Debian slim, pinned by digest for reproducible builds.
ARG NODE_IMAGE=node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

# ---- Install the full dependency graph from the lockfile ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

# ---- Compile workspaces and bundle the web application ----
FROM deps AS build
COPY tsconfig.base.json tsconfig.build.base.json tsconfig.build.json ./
COPY packages packages
COPY apps apps
RUN npm run build

# ---- Production dependencies for the server and its workspace packages only ----
FROM ${NODE_IMAGE} AS runtime-deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund --workspace @ripple/server

# ---- Runtime image ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_ROOT=/app/apps/web/dist
WORKDIR /app

COPY --from=runtime-deps --chown=node:node /app/node_modules node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node packages/contracts/package.json packages/contracts/
COPY --chown=node:node packages/database/package.json packages/database/
COPY --chown=node:node apps/server/package.json apps/server/
COPY --from=build --chown=node:node /app/packages/contracts/dist packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/database/dist packages/database/dist
COPY --from=build --chown=node:node /app/packages/database/migrations packages/database/migrations
COPY --from=build --chown=node:node /app/apps/server/dist apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist apps/web/dist

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "apps/server/dist/main.js"]
