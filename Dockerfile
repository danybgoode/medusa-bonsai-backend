# Medusa v2 backend — production image for Cloud Run (us-east4).
# Build context is apps/backend (this directory), NOT the monorepo root:
#   docker build -t <region>-docker.pkg.dev/<project>/medusa/backend:latest apps/backend
#
# `medusa build` emits a self-contained server under .medusa/server with its own
# package.json, so the runtime stage installs only production deps from there.

# ---- Builder ---------------------------------------------------------------
FROM node:20-slim AS builder
ENV NODE_ENV=development
WORKDIR /app

# .npmrc carries legacy-peer-deps=true. No per-app lockfile in this monorepo, so
# we install fresh here (deps are caret-pinned to @medusajs 2.15.x).
COPY package.json .npmrc ./
RUN npm install

COPY . .
RUN npm run build

# ---- Runner ----------------------------------------------------------------
FROM node:20-slim AS runner
ENV NODE_ENV=production
# Cloud Run injects PORT (default 8080); Medusa binds process.env.PORT.
ENV PORT=8080
WORKDIR /app

# The build output is a standalone deployable app.
COPY --from=builder /app/.medusa/server ./
COPY --from=builder /app/.npmrc ./
RUN npm install --omit=dev

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
