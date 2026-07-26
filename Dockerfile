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
# BuildKit CACHE MOUNT on the one install the registry layer-cache structurally cannot help.
#
# The layer above invalidates on every build by design: .medusa/server/package.json is not
# byte-stable across `medusa build` runs, so its COPY hash changes and this RUN always re-executes.
# A cache mount is a DIFFERENT primitive from the registry layer cache already configured — it
# persists the downloaded npm store independently of the layer hash, so the reinstall still runs but
# fetches from disk instead of the network.
#
# ⚠️ UNMEASURED as of 2026-07-26. This only pays off if Cloud Build persists the mount BETWEEN builds,
# which is the open question and cannot be answered locally: it needs two consecutive real Cloud Build
# runs compared against the pre-change baseline. Per the sprint contract this change is NOT to be kept
# on faith — if two consecutive builds show no improvement, revert it and record the negative result.
# A change that bought nothing is not "harmless"; it is noise that the next person has to re-evaluate.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
