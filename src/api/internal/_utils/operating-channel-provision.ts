/**
 * operating-channel-provision.ts — creating the operating channel and giving it the
 * stock-location links D5 requires, as ONE implementation shared by the internal
 * route and the `medusa exec` script.
 *
 * ── WHY THIS EXISTS AS A ROUTE AT ALL ─────────────────────────────────────────
 * Sprint 1 shipped provisioning as a `medusa exec` script, and the PR handed over
 * `npx medusa exec ./src/scripts/provision-mx-operating-channel.ts` as the operator
 * command. **That command cannot run.** Measured 2026-07-31: production's
 * `DATABASE_URL` resolves to `10.7.0.3`, a Cloud SQL PRIVATE ip, and the instance
 * (`medusa-pg`) has `ipv4Enabled: false` — there is no public endpoint, so a laptop
 * outside the VPC times out acquiring a connection no matter what credentials it
 * holds. `cleanup-default-data.ts` carries the same shape and its own header admits
 * it "has never been run against production"; this is why.
 *
 * Every OTHER production mutation in this repo is an internal HTTP route
 * (`market-backfill`, `prune-sales-channels`, `prune-api-keys`, `setup-mexico`) —
 * because a route runs INSIDE the VPC, on the real service, with the real Redis,
 * the real locking provider and the real module config. The script was the odd one
 * out. So the logic moves here and both callers share it: the route is the path that
 * actually runs, and the script stays honest about needing VPC access.
 *
 * A dry run is FULLY read-only — no workflow, no link, no write. Same posture as
 * `prune-sales-channels`: `dry_run` is true unless explicitly `false`.
 */

import { createSalesChannelsWorkflow } from '@medusajs/medusa/core-flows'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import {
  type MarketMedusaEnv,
  resolveMarketplaceChannelForMarket,
  resolveOperatingChannelForMarket,
} from '../../../lib/market-medusa'
import type { MarketCode } from '../../../lib/markets'
import { ensureSalesChannelLocationLink } from '../../store/_utils/inventory'
import { locationIdsForChannel, planStockLocationLinks } from './stock-location-graph'

/**
 * Cosmetic only — the id is what matters and is stable once created. Paired with
 * "Miyagi Markets MX" (the marketplace channel's display name) so Admin reads the
 * two channels as a matched set rather than a stray duplicate.
 */
export const OPERATING_CHANNEL_NAME = 'Miyagi Operating MX'
export const OPERATING_CHANNEL_DESCRIPTION =
  'Buyability channel for MX-operated shops (owned-shop-operating-channel epic). ' +
  'Every MX seller\'s product is a member regardless of marketplace publication — ' +
  'see Roadmap/07-agentic-and-federated-commerce/owned-shop-operating-channel.'

export interface ProvisionReport {
  readonly dry_run: boolean
  readonly market_code: MarketCode
  /** Non-empty ⇒ nothing was done and nothing may be. */
  readonly blocked_by: string[]
  readonly channel_id: string | null
  readonly channel_name: string | null
  readonly channel_created: boolean
  readonly would_create: boolean
  readonly stock_locations: {
    readonly marketplace: string[]
    readonly operating_before: string[]
    readonly operating_after: string[]
    readonly missing: string[]
    readonly linked: string[]
  }
  /** The one manual step this cannot do for itself. Null once the var is set. */
  readonly action_required: string | null
}

type Scope = { resolve: (key: string) => any }

/**
 * Decide-and-(optionally)-apply. Ordering is deliberate and mirrors the backfill
 * route's rule: everything that can refuse the run is evaluated BEFORE the first
 * write, so a dry run renders exactly the verdict an apply would reach.
 */
export async function provisionOperatingChannel(
  scope: Scope,
  opts: { market: MarketCode; apply: boolean; env: MarketMedusaEnv },
): Promise<ProvisionReport> {
  const { market, apply, env } = opts
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const blocked: string[] = []
  const empty = { marketplace: [], operating_before: [], operating_after: [], missing: [], linked: [] }

  if (market !== 'mx') {
    return {
      dry_run: !apply, market_code: market,
      blocked_by: ['This legacy provisioner is MX-only; use /internal/us-commerce-provision for the owned US resource pack.'],
      channel_id: null, channel_name: null, channel_created: false, would_create: false,
      stock_locations: empty, action_required: null,
    }
  }

  // ── 0. D5's source: the marketplace channel, whose links we replicate. ──────
  const marketplaceChannel = resolveMarketplaceChannelForMarket(market, env)
  if (marketplaceChannel.status !== 'resolved') {
    blocked.push(`Marketplace channel unavailable — cannot determine which stock locations to replicate: ${marketplaceChannel.reason}`)
    return {
      dry_run: !apply, market_code: market, blocked_by: blocked,
      channel_id: null, channel_name: null, channel_created: false, would_create: false,
      stock_locations: empty, action_required: null,
    }
  }

  // ── 1. Today's operating channel, if any. ──────────────────────────────────
  const configured = resolveOperatingChannelForMarket(market, env)
  let channelId: string | null = null
  let channelName: string | null = null
  let created = false
  let wouldCreate = false

  if (configured.status === 'resolved') {
    const { data } = await query.graph({
      entity: 'sales_channel',
      fields: ['id', 'name'],
      filters: { id: configured.id },
    })
    const row = (data ?? [])[0] as { id: string; name?: string } | undefined
    if (!row) {
      // A configured id with no row is a GHOST. Creating a second channel under a
      // fresh id here would leave the env var pointing at nothing while a real
      // channel accumulated links — two half-truths instead of one clear fault.
      blocked.push(
        `MEDUSA_MX_OPERATING_CHANNEL_ID="${configured.id}" is set but no such Sales Channel exists in this database. ` +
        'Refusing to create a SECOND channel under a different id — fix or unset the env var first.',
      )
      return {
        dry_run: !apply, market_code: market, blocked_by: blocked,
        channel_id: null, channel_name: null, channel_created: false, would_create: false,
        stock_locations: empty, action_required: null,
      }
    }
    channelId = row.id
    channelName = row.name ?? null
  } else if (configured.status === 'no_resource') {
    // Structural: this market has no operating channel in any environment.
    blocked.push(`Market "${market}" has no operating channel in any environment: ${configured.reason}`)
    return {
      dry_run: !apply, market_code: market, blocked_by: blocked,
      channel_id: null, channel_name: null, channel_created: false, would_create: false,
      stock_locations: empty, action_required: null,
    }
  } else {
    // `unconfigured` — the expected state on the FIRST provisioning run.
    wouldCreate = true
    if (apply) {
      const { result } = await createSalesChannelsWorkflow(scope as any).run({
        input: { salesChannelsData: [{ name: OPERATING_CHANNEL_NAME, description: OPERATING_CHANNEL_DESCRIPTION }] },
      })
      channelId = result[0].id
      channelName = OPERATING_CHANNEL_NAME
      created = true
    }
  }

  // ── 2. D5 — the stock-location graph, before and after. ────────────────────
  const marketplaceIds = await locationIdsForChannel(query, marketplaceChannel.id)
  if (!channelId) {
    // Dry run before the channel exists: report the SOURCE set so the operator can
    // see exactly what the apply will replicate, rather than an empty graph that
    // reads like "nothing to do".
    return {
      dry_run: !apply, market_code: market, blocked_by: blocked,
      channel_id: null, channel_name: null, channel_created: false, would_create: wouldCreate,
      stock_locations: { ...empty, marketplace: marketplaceIds, missing: marketplaceIds },
      action_required: null,
    }
  }

  const before = await locationIdsForChannel(query, channelId)
  const plan = planStockLocationLinks(marketplaceIds, before)
  let after = before
  const linked: string[] = []
  if (apply && plan.missing_on_operating.length > 0) {
    for (const locationId of plan.missing_on_operating) {
      await ensureSalesChannelLocationLink(scope, channelId, locationId)
      linked.push(locationId)
    }
    after = await locationIdsForChannel(query, channelId)
  }

  return {
    dry_run: !apply,
    market_code: market,
    blocked_by: blocked,
    channel_id: channelId,
    channel_name: channelName,
    channel_created: created,
    would_create: wouldCreate,
    stock_locations: {
      marketplace: marketplaceIds,
      operating_before: before,
      operating_after: after,
      missing: [...plan.missing_on_operating],
      linked,
    },
    // Until the env var names the new channel, it is UNPROTECTED (the allow-list is
    // registry-derived) and unaddressable by every other route here. D10.
    action_required: created
      ? `Set MEDUSA_MX_OPERATING_CHANNEL_ID=${channelId} on the backend service and redeploy. ` +
        'Until then this channel exists but is unprotected by the destructive-cleanup allow-list.'
      : null,
  }
}
