/**
 * /internal/market-backfill — the one pre-launch MX backfill of the
 * market-architecture-foundation epic, and the gate that must be read before the
 * marketplace Sales Channel filter ships.
 *
 *   GET  — FULLY READ-ONLY dry-run report. No writes, no workflows, no logs.
 *   POST — applies, idempotently. **A builder never runs the POST**; Daniel runs it
 *          after reviewing the GET (WAYS-OF-WORKING: shared/prod mutations are the
 *          orchestrator's, not the builder's).
 *
 * WHY THIS EXISTS AT ALL (epic README, D1): the marketplace read boundary is NEW
 * enforcement. Until this epic, `/store/listings` returned every published product
 * with no Sales Channel constraint, so switching the filter on can HIDE a product
 * that is visible today. `published_without_market_channel` below is that exact
 * count — a zero makes the cutover a no-op, a non-zero makes it a backfill instead
 * of a surprise.
 *
 * NO MIGRATION (D12): `operating_market` rides the seller's existing `metadata` json
 * column. There is no DDL here and no `schema_migrations` realignment.
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET (same contract as every
 * sibling /internal route).
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { linkProductsToSalesChannelWorkflow } from '@medusajs/medusa/core-flows'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'
import { DEFAULT_MARKET, MARKETS, requireMarket, type MarketCode } from '../../../lib/markets'
import { resolveMarketplaceChannelForMarket } from '../../../lib/market-medusa'
import {
  planSellerMarketBackfill,
  readSellerOperatingMarket,
  setSellerOperatingMarket,
} from '../../../lib/seller-market'
import {
  MARKETPLACE_CHANNEL_FIELDS,
  reportMarketplaceMembership,
} from '../../store/_utils/market-read'
import { isHiddenCatalogProduct } from '../../store/_utils/support'

/**
 * The display name the MX marketplace channel should carry.
 *
 * COSMETIC ONLY. The channel id (`sc_01KSK1J0V81P4EPY9G0JAPX353`) is stable and must
 * never change: the storefront's only publishable key is linked to it and every
 * product↔channel link row references it. Renaming makes what the channel MEANS
 * legible in Admin — "Miyagi Sánchez Storefront" reads like a website, not like a
 * country marketplace.
 */
const MX_MARKETPLACE_CHANNEL_NAME = 'Miyagi Markets MX'

function authed(req: MedusaRequest): boolean {
  const secret = process.env.MEDUSA_INTERNAL_SECRET
  const provided = req.headers['x-internal-secret'] as string | undefined
  return !secret || provided === secret
}

interface ProductRow {
  id: string
  title?: string | null
  metadata?: Record<string, unknown> | null
  sales_channels?: Array<{ id?: string } | null> | null
}

/**
 * Gather everything both halves need. PURE-ISH: reads only, no writes, so the GET
 * can call it and stay honestly read-only and the POST can call it to decide.
 */
async function survey(req: MedusaRequest, market: MarketCode) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)

  const channel = resolveMarketplaceChannelForMarket(market, process.env)

  const sellers = await sellerService.listSellers({}, { take: 2000 })
  const sellerPlan = planSellerMarketBackfill(
    sellers.map((s: any) => ({ id: s.id, slug: s.slug, metadata: s.metadata })),
    market,
  )

  // Published products only: a draft is not in the catalog under any market, so
  // counting it here would inflate the exposure number this report exists to answer.
  const { data: products } = await query.graph({
    entity: 'product',
    fields: ['id', 'title', 'metadata', ...MARKETPLACE_CHANNEL_FIELDS],
    filters: { status: 'published' } as any,
    pagination: { take: 5000, skip: 0 },
  })
  const published = (products ?? []) as ProductRow[]

  const membership = channel.status === 'resolved'
    ? reportMarketplaceMembership(published, channel.id)
    : null

  return { channel, sellers, sellerPlan, published, membership, query }
}

/** Split the unlinked set by whether it would ever have been in the grid anyway. */
function classifyMissing(missing: ProductRow[]) {
  const hidden = missing.filter((p) =>
    !!(p.metadata as any)?.is_print_placement || isHiddenCatalogProduct(p.metadata),
  )
  const hiddenIds = new Set(hidden.map((p) => p.id))
  return {
    // These are the ones a buyer would actually stop seeing.
    buyer_visible: missing.filter((p) => !hiddenIds.has(p.id)),
    // Print-ad placements and support primitives are already filtered out of
    // /store/listings by their own rules, so they are unlinked AND invisible today —
    // reported separately so the headline number is not inflated by non-catalog rows.
    already_filtered: hidden,
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!authed(req)) return res.status(401).json({ message: 'Unauthorized' })

  let market: MarketCode
  try {
    market = requireMarket((req.query as Record<string, string>)?.market ?? DEFAULT_MARKET).code
  } catch (e) {
    return res.status(400).json({ message: (e as Error).message })
  }

  const { channel, sellerPlan, published, membership, query } = await survey(req, market)

  if (channel.status !== 'resolved' || !membership) {
    // Never a confident empty result: say WHY there is no report rather than
    // returning zeroes that read like a clean bill of health.
    return res.status(503).json({
      dry_run: true,
      market_code: market,
      unavailable: true,
      reason: channel.status === 'resolved' ? 'membership unavailable' : channel.reason,
    })
  }

  const [channelRow] = ((await query.graph({
    entity: 'sales_channel',
    fields: ['id', 'name'],
    filters: { id: channel.id } as any,
  })).data ?? []) as Array<{ id: string; name?: string }>

  const missing = classifyMissing(membership.missing)

  return res.json({
    dry_run: true,
    market_code: market,
    marketplace_status: MARKETS[market].marketplace_status,
    channel: {
      id: channel.id,
      current_name: channelRow?.name ?? null,
      proposed_name: MX_MARKETPLACE_CHANNEL_NAME,
      rename_needed: !!channelRow && channelRow.name !== MX_MARKETPLACE_CHANNEL_NAME,
      // A channel id that resolves to no row is a configuration error, not an empty
      // marketplace — name it rather than reporting 0 products.
      resolved_in_database: !!channelRow,
    },
    sellers: {
      total: sellerPlan.updates.length + sellerPlan.unchanged.length + sellerPlan.unknown.length,
      would_set: sellerPlan.updates,
      already_set: sellerPlan.unchanged,
      // Non-empty ⇒ the POST refuses. A seller carrying a value we cannot classify
      // is a row we must not touch and a signal that something else wrote this key.
      unknown_market: sellerPlan.unknown,
      abort: sellerPlan.abort,
    },
    products: {
      published_scanned: published.length,
      linked_to_market_channel: membership.linked,
      // ── THE GATE (D1) ──────────────────────────────────────────────────────
      // Published products with NO link to this market's marketplace channel.
      // These are exactly the products the new read filter would hide.
      published_without_market_channel: membership.missing.length,
      published_without_market_channel_buyer_visible: missing.buyer_visible.length,
      published_without_market_channel_already_filtered: missing.already_filtered.length,
      // >0 means dangling link rows exist and this report is under-counting.
      unusable_link_rows: membership.unusable_link_rows,
      would_link: missing.buyer_visible.concat(missing.already_filtered)
        .slice(0, 200)
        .map((p) => ({ id: p.id, title: p.title ?? null })),
    },
  })
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!authed(req)) return res.status(401).json({ message: 'Unauthorized' })

  let market: MarketCode
  try {
    market = requireMarket((req.body as any)?.market ?? DEFAULT_MARKET).code
  } catch (e) {
    return res.status(400).json({ message: (e as Error).message })
  }

  const { channel, sellerPlan, membership } = await survey(req, market)

  if (channel.status !== 'resolved' || !membership) {
    return res.status(503).json({
      applied: false,
      market_code: market,
      reason: channel.status === 'resolved' ? 'membership unavailable' : channel.reason,
    })
  }
  if (sellerPlan.abort) {
    // Abort on an unknown-market population rather than guessing (build contract).
    return res.status(422).json({
      applied: false,
      market_code: market,
      reason: 'At least one seller carries an unrecognised operating_market. Repair those rows first.',
      unknown_market: sellerPlan.unknown,
    })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const salesChannelService: any = req.scope.resolve(Modules.SALES_CHANNEL)

  // ── 1. Seller operating_market ────────────────────────────────────────────
  // Re-read each seller immediately before writing. A read is not a claim: the plan
  // above was computed from a list read, and `updateSellers` replaces the whole
  // metadata bag — so a value written between the two would be clobbered. The
  // re-read narrows the window AND makes the apply idempotent: a seller that already
  // has a value is skipped, so a second run is a no-op rather than a rewrite.
  let sellersUpdated = 0
  let sellersSkipped = 0
  for (const update of sellerPlan.updates) {
    const [fresh] = await sellerService.listSellers({ id: update.id }, { take: 1 })
    if (!fresh) { sellersSkipped += 1; continue }
    if (readSellerOperatingMarket(fresh).source !== 'legacy_default') { sellersSkipped += 1; continue }
    await sellerService.updateSellers({
      id: fresh.id,
      metadata: setSellerOperatingMarket(fresh.metadata, market),
    })
    sellersUpdated += 1
  }

  // ── 2. Publish the unlinked published products into the market channel ────
  // Idempotent by construction: only ids that are missing the link are passed.
  const toLink = membership.missing.map((p) => p.id)
  if (toLink.length > 0) {
    await linkProductsToSalesChannelWorkflow(req.scope).run({
      input: { id: channel.id, add: toLink },
    })
  }

  // ── 3. Cosmetic: name the channel for what it is ──────────────────────────
  // Id unchanged — only the display name.
  let renamed = false
  const [channelRow] = await salesChannelService.listSalesChannels({ id: channel.id }, { take: 1 })
  if (channelRow && channelRow.name !== MX_MARKETPLACE_CHANNEL_NAME && market === 'mx') {
    await salesChannelService.updateSalesChannels(channel.id, { name: MX_MARKETPLACE_CHANNEL_NAME })
    renamed = true
  }

  return res.json({
    applied: true,
    market_code: market,
    channel_id: channel.id,
    sellers_updated: sellersUpdated,
    sellers_skipped: sellersSkipped,
    products_linked: toLink.length,
    channel_renamed: renamed,
  })
}
