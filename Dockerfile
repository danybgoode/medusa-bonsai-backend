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

# .npmrc carries legacy-peer-deps=true. package-lock.json makes this a
# deterministic, reproducible install (deps are caret-pinned to @medusajs
# 2.15.x in package.json, but npm ci pins to exactly what's in the lockfile).
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Runner ----------------------------------------------------------------
FROM node:20-slim AS runner
ENV NODE_ENV=production
# Cloud Run injects PORT (default 8080); Medusa binds process.env.PORT.
ENV PORT=8080
WORKDIR /app

# The build output is a standalone deployable app. `medusa build` emits
# .medusa/server/package.json with the IDENTICAL dependencies/devDependencies
# as the source package.json (verified), so the same lockfile applies here too.
COPY --from=builder /app/.medusa/server ./
COPY --from=builder /app/.npmrc ./
COPY --from=builder /app/package-lock.json ./
RUN npm ci --omit=dev

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
