# syntax=docker/dockerfile:1
# Medusa v2 backend — production image for Cloud Run (us-east4).
# Build context is apps/backend (this directory), NOT the monorepo root:
#   docker build -t <region>-docker.pkg.dev/<project>/medusa/backend:latest apps/backend
#
# `medusa build` emits a self-contained server under .medusa/server with its own
# package.json, so the runtime stage installs only production deps from there.

# ---- Builder ---------------------------------------------------------------
FROM node:22-slim AS builder
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
FROM node:22-slim AS runner
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
# BuildKit CACHE MOUNT on the one install the registry layer-cache cannot always help.
#
# MEASURED 2026-07-27, and the measurement had to change to be meaningful. Total build time is useless
# here: five consecutive backend builds ranged 7m49s to 23m24s, a 15-minute spread that swamps any
# plausible saving. The answerable number is the per-LAYER timing BuildKit already prints
# (`gcloud builds log <id> | grep '#17 DONE'` for this exact step):
#
#     ~306s / ~293s   when this layer actually runs
#     ~1.3s           when the registry layer cache hits it
#
# That also corrects the comment above: the layer does NOT invalidate on every build — it cache-HIT on
# 3 of 5 sampled builds. So the mount pays only on the minority of builds where the layer genuinely
# re-runs, and there it takes a real bite out of ~5 minutes by fetching the npm store from disk instead
# of the network. Kept on that basis: a bounded win on the slow path, and inert on the fast one, since
# a skipped layer never evaluates its mount.
#
# Requires the `# syntax=docker/dockerfile:1` directive at the top of this file — which this Dockerfile
# did not have, a prerequisite the audit proposing the change never mentioned.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
