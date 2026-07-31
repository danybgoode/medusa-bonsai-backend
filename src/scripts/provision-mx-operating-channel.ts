/**
 * owned-shop-operating-channel epic, Sprint 1 Story 1.3 — provision the MX operating
 * channel and link it to every stock location the marketplace channel is linked to
 * (epic README, D5 + D10).
 *
 *   DRY RUN (default — prints, creates/writes nothing):
 *     npx medusa exec ./src/scripts/provision-mx-operating-channel.ts
 *   APPLY:
 *     PROVISION_OPERATING_CHANNEL_APPLY=1 npx medusa exec ./src/scripts/provision-mx-operating-channel.ts
 *
 * SEQUENCING (D10, non-negotiable): this script must be run only AFTER the allow-list
 * entry (S1.2/1.3 code — `registryOperatingChannelIds` in `protectedSalesChannelIds`)
 * has DEPLOYED. Do not run this against a deploy that predates that PR — the channel
 * this script creates would exist for a window with no code protecting it from
 * `cleanup-default-data.ts` / `POST /internal/prune-sales-channels`.
 *
 * WHAT THIS DOES, idempotently:
 *   1. Resolve today's operating channel: `MEDUSA_MX_OPERATING_CHANNEL_ID` if set AND
 *      the row still exists in the database, else "not yet provisioned".
 *   2. If not yet provisioned: CREATE it (APPLY only). The created id is printed —
 *      the operator must set `MEDUSA_MX_OPERATING_CHANNEL_ID` to it and redeploy
 *      before the channel is protected or addressable by anything else in this repo.
 *   3. D5: link the operating channel to every stock location the MARKETPLACE
 *      channel (`MEDUSA_SALES_CHANNEL_ID`) is linked to, via the existing
 *      `ensureSalesChannelLocationLink` — never a second implementation of it.
 *      Reports the location↔channel graph BEFORE and AFTER.
 *
 * This is a PRODUCTION MUTATION. Per AGENTS.md and the epic README ("Deploy order"),
 * the builder never runs the APPLY form — Daniel does, after reviewing the DRY RUN
 * output, and only once he has confirmed the allow-list PR from S1.2/1.3 is live.
 */

import { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { createSalesChannelsWorkflow } from '@medusajs/medusa/core-flows'
import { resolveMarketplaceChannelForMarket, resolveOperatingChannelForMarket } from '../lib/market-medusa'
import { ensureSalesChannelLocationLink } from '../api/store/_utils/inventory'
import { locationIdsForChannel, planStockLocationLinks } from '../api/internal/_utils/stock-location-graph'

/**
 * Cosmetic only — the id is what matters and is stable once created. Paired with
 * "Miyagi Markets MX" (the marketplace channel's display name) so Admin reads the
 * two channels as a matched set rather than a stray duplicate.
 */
const OPERATING_CHANNEL_NAME = 'Miyagi Operating MX'
const OPERATING_CHANNEL_DESCRIPTION =
  'Buyability channel for MX-operated shops (owned-shop-operating-channel epic). ' +
  'Every MX seller\'s product is a member regardless of marketplace publication — ' +
  'see Roadmap/07-agentic-and-federated-commerce/owned-shop-operating-channel.'

export default async function provisionMxOperatingChannel({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const apply = process.env.PROVISION_OPERATING_CHANNEL_APPLY === '1'

  // ── 0. The marketplace channel must be addressable — it is what D5 replicates. ──
  const marketplaceChannel = resolveMarketplaceChannelForMarket('mx', process.env)
  if (marketplaceChannel.status !== 'resolved') {
    logger.error(`[provision-operating-channel] marketplace channel unavailable: ${marketplaceChannel.reason} — ABORT`)
    return
  }

  // ── 1. Resolve today's operating channel, if any. ────────────────────────────
  const configured = resolveOperatingChannelForMarket('mx', process.env)
  let operatingChannelId: string | null = null
  let operatingChannelName: string | null = null

  if (configured.status === 'resolved') {
    const { data } = await query.graph({
      entity: 'sales_channel',
      fields: ['id', 'name'],
      filters: { id: configured.id },
    })
    const row = (data ?? [])[0] as { id: string; name?: string } | undefined
    if (row) {
      operatingChannelId = row.id
      operatingChannelName = row.name ?? null
      logger.info(`[provision-operating-channel] MEDUSA_MX_OPERATING_CHANNEL_ID already resolves to an existing channel: ${row.id} ("${row.name}") — skipping creation`)
    } else {
      logger.error(`[provision-operating-channel] MEDUSA_MX_OPERATING_CHANNEL_ID="${configured.id}" is set but no such Sales Channel exists in this database. ` +
        'Refusing to create a SECOND channel under a different id while this env var points at a ghost — fix the env var or unset it first. ABORT.')
      return
    }
  } else {
    logger.info(`[provision-operating-channel] MEDUSA_MX_OPERATING_CHANNEL_ID not configured (${configured.status}) — would create "${OPERATING_CHANNEL_NAME}"`)
    if (apply) {
      const { result } = await createSalesChannelsWorkflow(container).run({
        input: {
          salesChannelsData: [{
            name: OPERATING_CHANNEL_NAME,
            description: OPERATING_CHANNEL_DESCRIPTION,
          }],
        },
      })
      operatingChannelId = result[0].id
      operatingChannelName = OPERATING_CHANNEL_NAME
      logger.info(`[provision-operating-channel] ✓ Created "${OPERATING_CHANNEL_NAME}" (${operatingChannelId}).`)
      logger.info(`[provision-operating-channel] ACTION REQUIRED: set MEDUSA_MX_OPERATING_CHANNEL_ID=${operatingChannelId} on the backend service and redeploy — until then this channel exists but is UNPROTECTED and unaddressable by every other route in this repo (D10).`)
    } else {
      logger.info('[provision-operating-channel] DRY RUN — nothing created. Re-run with PROVISION_OPERATING_CHANNEL_APPLY=1 once the allow-list PR (S1.2/1.3) is confirmed live.')
      // Nothing to link yet without a real id — the stock-location section below is
      // reported against the marketplace channel alone in this branch.
    }
  }

  // ── 2. D5 — the stock-location ↔ channel graph, before and after. ────────────
  const marketplaceLocationIds = await locationIdsForChannel(query, marketplaceChannel.id)
  logger.info(`[provision-operating-channel] marketplace channel (${marketplaceChannel.id}) stock locations: [${marketplaceLocationIds.join(', ')}]`)

  if (!operatingChannelId) {
    logger.info('[provision-operating-channel] no operating channel id available yet (dry run, not created) — stock-location diff skipped. Re-run after APPLY.')
    return
  }

  const before = await locationIdsForChannel(query, operatingChannelId)
  const plan = planStockLocationLinks(marketplaceLocationIds, before)
  logger.info(`[provision-operating-channel] operating channel (${operatingChannelId}, "${operatingChannelName}") stock locations BEFORE: [${before.join(', ')}]`)
  logger.info(`[provision-operating-channel] missing on operating channel: [${plan.missing_on_operating.join(', ')}]`)

  if (plan.missing_on_operating.length === 0) {
    logger.info('[provision-operating-channel] ○ Stock-location graph already matches — nothing to link.')
    return
  }

  if (!apply) {
    logger.info(`[provision-operating-channel] DRY RUN — would link ${plan.missing_on_operating.length} stock location(s) to the operating channel. Nothing written.`)
    return
  }

  for (const locationId of plan.missing_on_operating) {
    await ensureSalesChannelLocationLink(container, operatingChannelId, locationId)
  }
  const after = await locationIdsForChannel(query, operatingChannelId)
  logger.info(`[provision-operating-channel] ✓ operating channel stock locations AFTER: [${after.join(', ')}]`)
}
