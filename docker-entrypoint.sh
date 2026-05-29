#!/bin/sh
set -e

# Run DB migrations on startup, except on the dedicated worker (avoids two
# services racing on migrate). Medusa migrations are idempotent + lock-guarded;
# for many web instances, move this to a Cloud Run pre-deploy job instead.
if [ "$MEDUSA_WORKER_MODE" != "worker" ]; then
  echo "[entrypoint] running migrations…"
  npx medusa db:migrate
fi

echo "[entrypoint] starting medusa (worker mode: ${MEDUSA_WORKER_MODE:-shared})…"
exec npx medusa start
