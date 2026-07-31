/**
 * owned-shop-operating-channel epic, S1.3 — provision the MX operating channel.
 *
 * ⚠️ THIS SCRIPT CANNOT RUN FROM OUTSIDE THE VPC, AND THAT IS NOT A BUG IN IT.
 * Production's Cloud SQL instance `medusa-pg` has `ipv4Enabled: false` and
 * DATABASE_URL resolves to the private ip 10.7.0.3, so `npx medusa exec` from a
 * laptop times out acquiring a connection regardless of credentials (measured
 * 2026-07-31). The same is true of every `medusa exec` script here — which is why
 * `cleanup-default-data.ts`'s own header admits it has never been run against
 * production.
 *
 * ✅ USE THE ROUTE INSTEAD: `/internal/operating-channel-provision` runs inside the
 * VPC on the live service, with the real Redis, locking provider and module config.
 *
 *     # dry run (read-only)
 *     curl -s -H "x-internal-secret: $MEDUSA_INTERNAL_SECRET" \
 *       'https://api.miyagisanchez.com/internal/operating-channel-provision?market=mx'
 *
 *     # apply
 *     curl -s -X POST -H "x-internal-secret: $MEDUSA_INTERNAL_SECRET" \
 *       -H 'content-type: application/json' -d '{"market":"mx","dry_run":false}' \
 *       'https://api.miyagisanchez.com/internal/operating-channel-provision'
 *
 * This script is kept as the equivalent entry point for an operator who DOES have
 * VPC access (Cloud Shell, a bastion, a VPC-connected Cloud Run job). It shares the
 * route's implementation exactly — `_utils/operating-channel-provision.ts` — so the
 * two can never drift, which was the actual risk in keeping both.
 *
 *   DRY RUN (default):  npx medusa exec ./src/scripts/provision-mx-operating-channel.ts
 *   APPLY:              PROVISION_OPERATING_CHANNEL_APPLY=1 npx medusa exec ./src/scripts/provision-mx-operating-channel.ts
 *
 * SEQUENCING (D10): run only AFTER the allow-list entry has deployed, or the channel
 * exists for a window with nothing protecting it from the destructive cleanups.
 */

import { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { provisionOperatingChannel } from '../api/internal/_utils/operating-channel-provision'

export default async function provisionMxOperatingChannel({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const apply = process.env.PROVISION_OPERATING_CHANNEL_APPLY === '1'

  const report = await provisionOperatingChannel(container, {
    market: 'mx',
    apply,
    env: process.env,
  })

  if (report.blocked_by.length > 0) {
    for (const reason of report.blocked_by) {
      logger.error(`[provision-operating-channel] ${reason}`)
    }
    logger.error('[provision-operating-channel] ABORT — nothing was created or linked.')
    return
  }

  logger.info(`[provision-operating-channel] ${report.dry_run ? 'DRY RUN' : 'APPLY'} · market=${report.market_code}`)
  logger.info(`[provision-operating-channel] channel: id=${report.channel_id ?? '(none yet)'} name="${report.channel_name ?? ''}" created=${report.channel_created} would_create=${report.would_create}`)
  logger.info(`[provision-operating-channel] stock locations — marketplace=[${report.stock_locations.marketplace.join(', ')}] operating_before=[${report.stock_locations.operating_before.join(', ')}] missing=[${report.stock_locations.missing.join(', ')}] linked=[${report.stock_locations.linked.join(', ')}] operating_after=[${report.stock_locations.operating_after.join(', ')}]`)
  if (report.action_required) {
    logger.info(`[provision-operating-channel] ACTION REQUIRED: ${report.action_required}`)
  }
}
