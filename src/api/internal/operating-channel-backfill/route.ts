/**
 * /internal/operating-channel-backfill — owned-shop-operating-channel epic, Sprint 1
 * Story 1.4. The sibling of `/internal/market-backfill`: same shape (validate → apply,
 * capped-scan refusal, per-seller market scoping, `internalSecretOk` fail-closed), a
 * DIFFERENT channel and a DIFFERENT product population.
 *
 *   GET  — FULLY READ-ONLY dry-run report. No writes, no workflows, no logs.
 *   POST — applies, idempotently. **A builder never runs the POST**; Daniel runs it
 *          after reviewing the GET (WAYS-OF-WORKING: shared/prod mutations are the
 *          orchestrator's, not the builder's).
 *
 * WHY THIS EXISTS (epic README): a product in NO Medusa Sales Channel cannot be
 * bought — `/store/products` 404s it and checkout fails "Product not found". The
 * operating channel is what makes "sell this on my own shop, don't list it in the
 * marketplace" possible; this route is the one-time full link of the catalog into it
 * before Sprint 2 makes that membership load-bearing (epic README, "Consequence for
 * S1.4").
 *
 * TWO DELIBERATE DEVIATIONS FROM THE MARKET-BACKFILL SIBLING (epic README, locked):
 *
 *   D6 — every product STATUS is scanned, not only `published`. A draft left out
 *        becomes unbuyable the moment it is published — a bug that would surface
 *        days after this epic closed. Linking a draft is inert: `/store/products`
 *        filters `status` on its own. The report gives the published/draft split
 *        (`splitByPublished`) so a reviewer sees this is NOT scoped like the
 *        marketplace backfill.
 *   D5 — the stock-location ↔ sales-channel graph is part of both the report and the
 *        apply. Medusa reserves inventory at order completion AGAINST THE CART'S
 *        CHANNEL, and the seeded stock location is linked to the MARKETPLACE channel
 *        only today. The moment Sprint 2 moves the cart onto the operating channel,
 *        every managed-inventory purchase fails at completion unless the operating
 *        channel carries the same stock-location link. Provisioning (S1.3) is the
 *        PRIMARY place this link is made; this route additionally ensures and
 *        re-reports it on every apply as a safety net, using the existing
 *        `ensureSalesChannelLocationLink` — never a second implementation of it.
 *
 * A PRODUCT IS ONLY LINKED INTO ITS OWNING SELLER'S OPERATING MARKET — never a
 * blanket link of every product to MX (`planMarketplaceLinkBackfill`, reused as-is:
 * its rule is "the owning seller's market", not "the marketplace", so it applies
 * unchanged to a different channel).
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET, and a MISSING secret
 * DENIES (src/lib/internal-auth.ts). This route links products and stock-location
 * rows; "the deploy is misconfigured" is exactly when it must not be open.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { linkProductsToSalesChannelWorkflow } from '@medusajs/medusa/core-flows'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'
import { DEFAULT_MARKET, requireMarket, type MarketCode } from '../../../lib/markets'
import {
  resolveMarketplaceChannelForMarket,
  resolveOperatingChannelForMarket,
} from '../../../lib/market-medusa'
import { planMarketplaceLinkBackfill, readSellerOperatingMarket } from '../../../lib/seller-market'
import { reportMarketplaceMembership } from '../../store/_utils/market-read'
import { resolveSellerProductIds } from '../../store/_utils/seller-catalog-query'
import { ensureSalesChannelLocationLink } from '../../store/_utils/inventory'
import { describeScan } from '../_utils/scan-window'
import {
  operatingChannelBackfillBlockingReasons,
  splitByPublished,
  type UnclassifiableSeller,
} from '../_utils/operating-channel-backfill'
import type { OwnershipScanFailure } from '../_utils/market-backfill'
import { planStockLocationLinks, type StockLocationLinkPlan } from '../_utils/stock-location-graph'
import { internalSecretOk } from '../../../lib/internal-auth'

/**
 * Scan windows. D1's measured population is 26 sellers / 77 PUBLISHED products; this
 * route scans every status (D6), so the true count is somewhat larger but nowhere
 * near either cap. The truncation branch stays explicit rather than trusted to stay
 * unreachable, exactly like the market-backfill sibling.
 */
const SELLER_SCAN_CAP = 2000
const PRODUCT_SCAN_CAP = 5000

function authed(req: MedusaRequest): boolean {
  // Fail CLOSED: a missing MEDUSA_INTERNAL_SECRET denies everyone. One definition,
  // in src/lib/internal-auth.ts — see the incident note there.
  return internalSecretOk(req)
}

interface ProductRow {
  id: string
  title?: string | null
  status?: string | null
  metadata?: Record<string, unknown> | null
  sales_channels?: Array<{ id?: string } | null> | null
}

/** Every stock-location id a Sales Channel is linked to. Read-only. */
async function locationIdsForChannel(query: any, channelId: string): Promise<string[]> {
  const { data } = await query.graph({
    entity: 'sales_channel',
    fields: ['id', 'stock_locations.id'],
    filters: { id: channelId } as any,
  })
  return ((data?.[0]?.stock_locations ?? []) as Array<{ id: string }>).map((l) => l.id)
}

interface StockLocationGraphReport {
  readonly available: boolean
  readonly reason: string | null
  readonly marketplace_location_ids: string[]
  readonly operating_location_ids: string[]
  readonly missing_on_operating: string[]
}

/**
 * D5 — read-only. Returns `available: false` (never a thrown error, never a
 * confident empty graph) when either channel cannot be resolved, so a reviewer sees
 * WHY the graph is absent rather than reading "nothing missing" as "already safe".
 */
async function readStockLocationGraph(
  req: MedusaRequest,
  market: MarketCode,
  operatingChannel: ReturnType<typeof resolveOperatingChannelForMarket>,
): Promise<StockLocationGraphReport> {
  const marketplaceChannel = resolveMarketplaceChannelForMarket(market, process.env)
  if (marketplaceChannel.status !== 'resolved') {
    return {
      available: false,
      reason: `Marketplace channel unavailable — cannot determine which stock locations to replicate: ${marketplaceChannel.reason}`,
      marketplace_location_ids: [],
      operating_location_ids: [],
      missing_on_operating: [],
    }
  }
  if (operatingChannel.status !== 'resolved') {
    return {
      available: false,
      reason: 'Operating channel unavailable — nothing to report a stock-location graph for yet.',
      marketplace_location_ids: [],
      operating_location_ids: [],
      missing_on_operating: [],
    }
  }
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const marketplaceIds = await locationIdsForChannel(query, marketplaceChannel.id)
  const operatingIds = await locationIdsForChannel(query, operatingChannel.id)
  const plan: StockLocationLinkPlan = planStockLocationLinks(marketplaceIds, operatingIds)
  return {
    available: true,
    reason: null,
    marketplace_location_ids: plan.marketplace_location_ids as string[],
    operating_location_ids: plan.operating_location_ids as string[],
    missing_on_operating: plan.missing_on_operating as string[],
  }
}

/**
 * Read everything both halves need. READ-ONLY — the GET calls it and stays honestly
 * side-effect free; the POST calls it to decide.
 */
async function survey(req: MedusaRequest, market: MarketCode) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)

  const channel = resolveOperatingChannelForMarket(market, process.env)

  // Does the configured channel actually EXIST? A stale env var pointing at a deleted
  // (or never-created) channel is indistinguishable from a healthy one until the
  // link workflow fails half-way through the apply.
  let channelRow: { id: string; name?: string } | null = null
  if (channel.status === 'resolved') {
    const { data } = await query.graph({
      entity: 'sales_channel',
      fields: ['id', 'name'],
      filters: { id: channel.id } as any,
    })
    channelRow = ((data ?? [])[0] as { id: string; name?: string } | undefined) ?? null
  }

  const sellers = await sellerService.listSellers({}, { take: SELLER_SCAN_CAP })
  const sellerScan = describeScan(sellers.length, SELLER_SCAN_CAP, 'sellers')

  // D6: every product status, not only published — see file header.
  const { data: products } = await query.graph({
    entity: 'product',
    fields: ['id', 'title', 'status', 'metadata', 'sales_channels.id'],
    pagination: { take: PRODUCT_SCAN_CAP, skip: 0 },
  })
  const allProducts = (products ?? []) as ProductRow[]
  const productScan = describeScan(allProducts.length, PRODUCT_SCAN_CAP, 'products (all statuses)')

  const membership = channel.status === 'resolved'
    ? reportMarketplaceMembership(allProducts, channel.id) // channel-agnostic despite the name — see market-read.ts
    : null

  // ── Ownership: which seller — and therefore which market — owns each product ──
  const ownerMarketByProduct = new Map<string, MarketCode>()
  const ownerSellerByProduct = new Map<string, string>()
  const ownershipScanFailures: OwnershipScanFailure[] = []
  const unclassifiableSellers: UnclassifiableSeller[] = []
  for (const seller of sellers as any[]) {
    const read = readSellerOperatingMarket(seller)
    if (!read.market) {
      // Unlike market-backfill (which is stamping ABSENT sellers into a target
      // market), this route never writes seller state — S1.1 already backfilled it
      // and D1 measured 0 unknowns. An unclassifiable row here still means "we must
      // not link this seller's products anywhere", reported explicitly rather than
      // silently skipped.
      unclassifiableSellers.push({ seller_id: seller.id, raw: read.raw })
      continue
    }
    try {
      const productIds = await resolveSellerProductIds(req.scope, seller.id)
      for (const productId of productIds) {
        ownerMarketByProduct.set(productId, read.market)
        ownerSellerByProduct.set(productId, seller.id)
      }
    } catch (error) {
      ownershipScanFailures.push({
        seller_id: seller.id,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const linkPlan = membership
    ? planMarketplaceLinkBackfill(
        membership.missing.map((p) => ({
          id: p.id,
          owner_market: ownerMarketByProduct.get(p.id) ?? null,
          owner_seller_id: ownerSellerByProduct.get(p.id) ?? null,
        })),
        market,
      )
    : null

  return {
    channel, channelRow, sellers, sellerScan,
    allProducts, membership, linkPlan, productScan,
    ownershipScanFailures, unclassifiableSellers, ownerSellerByProduct,
  }
}

/**
 * Every precondition, evaluated BEFORE any write. Pure with respect to the survey it
 * is handed, so the GET renders exactly the verdict the POST will enforce.
 */
function blockingReasons(s: Awaited<ReturnType<typeof survey>>): string[] {
  return operatingChannelBackfillBlockingReasons({
    channel: s.channel,
    channel_exists: !!s.channelRow,
    seller_scan: s.sellerScan,
    product_scan: s.productScan,
    ownership_scan_failures: s.ownershipScanFailures,
    unclassifiable_sellers: s.unclassifiableSellers,
    link_plan: s.linkPlan,
  })
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!authed(req)) return res.status(401).json({ message: 'Unauthorized' })

  let market: MarketCode
  try {
    market = requireMarket((req.query as Record<string, string>)?.market ?? DEFAULT_MARKET).code
  } catch (e) {
    return res.status(400).json({ message: (e as Error).message })
  }

  const s = await survey(req, market)
  const blocked_by = blockingReasons(s)

  if (!s.membership || !s.linkPlan) {
    // Never a confident empty result: say WHY there is no report rather than
    // returning zeroes that read like a clean bill of health.
    return res.status(503).json({
      dry_run: true,
      market_code: market,
      unavailable: true,
      apply_allowed: false,
      blocked_by,
    })
  }

  const scannedSplit = splitByPublished(s.allProducts)
  const missingIds = new Set(s.membership.missing.map((p) => p.id))
  const alreadyLinkedSplit = splitByPublished(s.allProducts.filter((p) => !missingIds.has(p.id)))
  const linkIds = new Set(s.linkPlan.link)
  const wouldLinkSplit = splitByPublished(s.allProducts.filter((p) => linkIds.has(p.id)))

  const stockLocations = await readStockLocationGraph(req, market, s.channel)

  return res.json({
    dry_run: true,
    market_code: market,
    // The POST refuses unless this is empty. Reported here so the reviewer sees the
    // same verdict the apply will reach, before running it.
    apply_allowed: blocked_by.length === 0,
    blocked_by,
    scan: { sellers: s.sellerScan, products: s.productScan },
    ownership_scan_failures: s.ownershipScanFailures,
    unclassifiable_sellers: s.unclassifiableSellers,
    channel: {
      id: s.channel.status === 'resolved' ? s.channel.id : null,
      resolved_in_database: !!s.channelRow,
      current_name: s.channelRow?.name ?? null,
    },
    products: {
      scanned: s.allProducts.length,
      // ── D6: the published/draft split, so a reviewer sees this is NOT scoped to
      // `published` the way the marketplace backfill is. ─────────────────────────
      scanned_published: scannedSplit.published.length,
      scanned_draft: scannedSplit.draft.length,
      already_in_operating_channel: s.membership.linked,
      already_in_operating_channel_published: alreadyLinkedSplit.published.length,
      already_in_operating_channel_draft: alreadyLinkedSplit.draft.length,
      // >0 means dangling link rows exist and this report is under-counting.
      unusable_link_rows: s.membership.unusable_link_rows,
      would_link: s.linkPlan.link.length,
      would_link_published: wouldLinkSplit.published.length,
      would_link_draft: wouldLinkSplit.draft.length,
      would_link_ids: s.linkPlan.link.slice(0, 200),
      // Owned by a seller operating in a DIFFERENT market — never linked here.
      skipped_other_market: s.linkPlan.skipped_other_market,
      // Reported, never adopted: a non-empty set also blocks POST.
      skipped_unowned: s.linkPlan.skipped_unowned,
    },
    // ── D5: the stock-location ↔ channel graph. Read-only here; POST ensures it. ──
    stock_locations: stockLocations,
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

  const s = await survey(req, market)

  // ── VALIDATE (pure, and BEFORE any write) ────────────────────────────────
  const blocked_by = blockingReasons(s)
  if (blocked_by.length > 0 || !s.membership || !s.linkPlan || s.channel.status !== 'resolved') {
    return res.status(422).json({
      applied: false,
      market_code: market,
      // Every reason at once, not one failure at a time.
      blocked_by: blocked_by.length > 0 ? blocked_by : ['Operating channel unavailable for this market.'],
      unclassifiable_sellers: s.unclassifiableSellers,
    })
  }

  // ── APPLY 1: link ONLY this market's sellers' products ────────────────────
  // Idempotent by construction: only ids missing the link are passed (D6: ANY
  // status), and a product owned by another market's seller — or by no resolvable
  // seller — is never linked.
  if (s.linkPlan.link.length > 0) {
    await linkProductsToSalesChannelWorkflow(req.scope).run({
      input: { id: s.channel.id, add: s.linkPlan.link },
    })
  }

  // ── APPLY 2 (D5): ensure the operating channel carries every stock-location
  // link the marketplace channel has. Provisioning (S1.3) is the primary place
  // this happens; re-asserting it here on every apply is the safety net the epic
  // README calls for, using the SAME `ensureSalesChannelLocationLink` — never a
  // second implementation. ───────────────────────────────────────────────────
  const marketplaceChannel = resolveMarketplaceChannelForMarket(market, process.env)
  let stockLocations: {
    applied: boolean
    reason: string | null
    before: string[]
    after: string[]
    linked: string[]
  } = { applied: false, reason: 'Marketplace channel unavailable.', before: [], after: [], linked: [] }

  if (marketplaceChannel.status === 'resolved') {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const marketplaceIds = await locationIdsForChannel(query, marketplaceChannel.id)
    const before = await locationIdsForChannel(query, s.channel.id)
    const plan = planStockLocationLinks(marketplaceIds, before)
    for (const locationId of plan.missing_on_operating) {
      await ensureSalesChannelLocationLink(req.scope, s.channel.id, locationId)
    }
    const after = plan.missing_on_operating.length > 0
      ? await locationIdsForChannel(query, s.channel.id)
      : before
    stockLocations = { applied: true, reason: null, before, after, linked: [...plan.missing_on_operating] }
  }

  return res.json({
    applied: true,
    market_code: market,
    channel_id: s.channel.id,
    // Both scans were complete or we would not be here.
    scan: { sellers: s.sellerScan, products: s.productScan },
    products_linked: s.linkPlan.link.length,
    products_skipped_other_market: s.linkPlan.skipped_other_market.length,
    products_skipped_unowned: s.linkPlan.skipped_unowned.length,
    stock_locations: stockLocations,
  })
}
