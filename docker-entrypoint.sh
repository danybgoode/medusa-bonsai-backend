#!/bin/sh
set -e

# Run DB migrations on startup, except on the dedicated worker (avoids two
# services racing on migrate). Medusa migrations are idempotent + lock-guarded;
# for many web instances, move this to a Cloud Run pre-deploy job instead.
if [ "$MEDUSA_WORKER_MODE" != "worker" ]; then
  echo "[entrypoint] running migrations…"
  # --execute-safe-links is LOAD-BEARING. Without it, `db:migrate` answers any link-table change it
  # classes as an UPDATE or DELETE with an INTERACTIVE prompt ("Select the tables to UPDATE…").
  # A container has no TTY, so the prompt waits forever, the server never binds :8080, and Cloud Run
  # kills the revision after its 4-minute startup probe. That happened on EVERY backend deploy from
  # 2026-09-11 to 2026-09-22: the Medusa 2.19→2.21 bump changed product_variant_inventory_item
  # .required_quantity from integer to numeric. Production silently stayed on the 09-04 revision.
  # Safe mode creates new link tables and skips updates and deletes WITHOUT prompting. A skipped
  # update is a deliberate operator step (`medusa db:sync-links`), never a boot-time side effect.
  npx medusa db:migrate --execute-safe-links
fi

echo "[entrypoint] starting medusa (worker mode: ${MEDUSA_WORKER_MODE:-shared})…"
exec npx medusa start
