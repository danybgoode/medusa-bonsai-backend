/**
 * /internal/market-backfill — the one pre-launch MX backfill of the
 * market-architecture-foundation epic, and the report that must be read before the
 * marketplace Sales Channel filter ships.
 *
 *   GET  — FULLY READ-ONLY dry-run report. No writes, no workflows, no logs.
 *   POST — applies, idempotently. **A builder never runs the POST**; Daniel runs it
 *          after reviewing the GET (WAYS-OF-WORKING: shared/prod mutations are the
 *          orchestrator's, not the builder's).
 *
 * WHY THIS EXISTS (epic README, D1): the marketplace read boundary is NEW enforcement.
 * Until this epic, `/store/listings` returned every published product with no Sales
 * Channel constraint, so switching the filter on can HIDE a product that is visible
 * today. `published_without_market_channel` below is that exact count.
 *
 * NO MIGRATION (D12): `operating_market` rides the seller's existing `metadata` json
 * column. There is no DDL here and no `schema_migrations` realignment.
 *
 * ── THREE RULES THIS ROUTE LEARNED FROM A CROSS-REVIEW ────────────────────────
 *
 * 1. VALIDATE → APPLY, and validation is pure so it goes FIRST. Every
 *    precondition (channel configured, channel actually PRESENT in the database,
 *    both scans complete, no unclassifiable seller) is checked BEFORE the first
 *    write. The earlier version reported a missing channel row on GET but did not
 *    enforce it on POST, so a stale `MEDUSA_SALES_CHANNEL_ID` would stamp every
 *    seller and then fail on the product link — a half-applied backfill, the worst
 *    possible thing to debug.
 *
 * 2. A PRODUCT IS ONLY LINKED INTO ITS OWNING SELLER'S MARKET. Linking every
 *    unlinked published product would publish a non-Mexico shop's catalog into the
 *    Mexico marketplace.
 *
 * 3. A CAPPED SCAN IS NOT A COMPLETE SCAN. If a read fills its window the counts are
 *    not authoritative and nothing may be applied against them.
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET, and a MISSING secret
 * DENIES (src/lib/internal-auth.ts). This route stamps sellers and links products;
 * "the deploy is misconfigured" is exactly when it must not be open.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { linkProductsToSalesChannelWorkflow } from '@medusajs/medusa/core-flows'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'
import { DEFAULT_MARKET, MARKETS, requireMarket, type MarketCode } from '../../../lib/markets'
import { resolveMarketplaceChannelForMarket } from '../../../lib/market-medusa'
import {
  planMarketplaceLinkBackfill,
  planSellerMarketBackfill,
  readSellerOperatingMarket,
  setSellerOperatingMarket,
} from '../../../lib/seller-market'
import {
  MARKETPLACE_CHANNEL_FIELDS,
  reportMarketplaceMembership,
} from '../../store/_utils/market-read'
import { isHiddenCatalogProduct } from '../../store/_utils/support'
import { resolveSellerProductIds } from '../../store/_utils/seller-catalog-query'
import { describeScan } from '../_utils/scan-window'
import {
  marketBackfillBlockingReasons,
  type OwnershipScanFailure,
} from '../_utils/market-backfill'
import { internalSecretOk } from '../../../lib/internal-auth'

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

/**
 * Scan windows. Today's population is 18 sellers / 77 products, so neither cap can
 * fire — which is precisely why the truncation branch has to be explicit instead of
 * trusted to stay unreachable.
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
  metadata?: Record<string, unknown> | null
  sales_channels?: Array<{ id?: string } | null> | null
}

/**
 * Read everything both halves need. READ-ONLY — the GET calls it and stays honestly
 * side-effect free; the POST calls it to decide.
 */
async function survey(req: MedusaRequest, market: MarketCode) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)

  const channel = resolveMarketplaceChannelForMarket(market, process.env)

  // Does the configured channel actually EXIST? A stale env var pointing at a deleted
  // channel is indistinguishable from a healthy one until the link workflow fails
  // half-way through the apply.
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
    pagination: { take: PRODUCT_SCAN_CAP, skip: 0 },
  })
  const published = (products ?? []) as ProductRow[]
  const productScan = describeScan(published.length, PRODUCT_SCAN_CAP, 'published products')

  const membership = channel.status === 'resolved'
    ? reportMarketplaceMembership(published, channel.id)
    : null

  // ── Ownership: which seller — and therefore which market — owns each product ──
  // The same per-seller link traversal `/store/listings` uses. A seller with no
  // linked products returns an empty Set. A thrown read is therefore genuinely
  // unavailable, not "this seller has no products"; preserve that third state and
  // block apply rather than converting an outage into a confident empty catalog.
  const ownerMarketByProduct = new Map<string, MarketCode>()
  const ownerSellerByProduct = new Map<string, string>()
  const ownershipScanFailures: OwnershipScanFailure[] = []
  for (const seller of sellers as any[]) {
    const read = readSellerOperatingMarket(seller)
    if (!read.market) continue // unclassifiable — the plan aborts the run on these
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
    query, channel, channelRow, sellers, sellerPlan,
    published, membership, linkPlan, sellerScan, productScan, ownershipScanFailures,
  }
}

/** Split the unlinked set by whether it would ever have been in the grid anyway. */
function classifyMissing(missing: ProductRow[]) {
  const hidden = missing.filter((p) =>
    !!(p.metadata as any)?.is_print_placement || isHiddenCatalogProduct(p.metadata),
  )
  const hiddenIds = new Set(hidden.map((p) => p.id))
  return {
    // The ones a buyer would actually stop seeing.
    buyer_visible: missing.filter((p) => !hiddenIds.has(p.id)),
    // Print-ad placements and support primitives are already filtered out of
    // /store/listings by their own rules, so they are unlinked AND invisible today —
    // reported separately so the headline number is not inflated by non-catalog rows.
    already_filtered: hidden,
  }
}

/**
 * Every precondition, evaluated BEFORE any write. Pure with respect to the survey it
 * is handed, so the GET renders exactly the verdict the POST will enforce — the two
 * cannot disagree about whether a run is safe.
 */
function blockingReasons(s: Awaited<ReturnType<typeof survey>>): string[] {
  return marketBackfillBlockingReasons({
    channel: s.channel,
    channel_exists: !!s.channelRow,
    seller_plan: s.sellerPlan,
    seller_scan: s.sellerScan,
    product_scan: s.productScan,
    ownership_scan_failures: s.ownershipScanFailures,
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

  const missing = classifyMissing(s.membership.missing)

  return res.json({
    dry_run: true,
    market_code: market,
    marketplace_status: MARKETS[market].marketplace_status,
    // The POST refuses unless this is empty. Reported here so the reviewer sees the
    // same verdict the apply will reach, before running it.
    apply_allowed: blocked_by.length === 0,
    blocked_by,
    scan: { sellers: s.sellerScan, products: s.productScan },
    ownership_scan_failures: s.ownershipScanFailures,
    channel: {
      id: s.channel.status === 'resolved' ? s.channel.id : null,
      resolved_in_database: !!s.channelRow,
      current_name: s.channelRow?.name ?? null,
      proposed_name: MX_MARKETPLACE_CHANNEL_NAME,
      rename_needed: !!s.channelRow && s.channelRow.name !== MX_MARKETPLACE_CHANNEL_NAME,
    },
    sellers: {
      total: s.sellerPlan.updates.length + s.sellerPlan.unchanged.length + s.sellerPlan.unknown.length,
      would_set: s.sellerPlan.updates,
      already_set: s.sellerPlan.unchanged,
      // Non-empty ⇒ the POST refuses. A seller carrying a value we cannot classify is
      // a row we must not touch, and a signal something else wrote this key.
      unknown_market: s.sellerPlan.unknown,
    },
    products: {
      published_scanned: s.published.length,
      linked_to_market_channel: s.membership.linked,
      // ── THE GATE (D1) ──────────────────────────────────────────────────────
      // Published products with NO link to this market's marketplace channel —
      // exactly the products the new read filter would hide.
      published_without_market_channel: s.membership.missing.length,
      published_without_market_channel_buyer_visible: missing.buyer_visible.length,
      published_without_market_channel_already_filtered: missing.already_filtered.length,
      // >0 means dangling link rows exist and this report is under-counting.
      unusable_link_rows: s.membership.unusable_link_rows,
      // Only products whose OWNING seller operates in this market are linkable.
      would_link: s.linkPlan.link.length,
      would_link_ids: s.linkPlan.link.slice(0, 200),
      skipped_other_market: s.linkPlan.skipped_other_market,
      // Reported, never adopted: an orphaned product is a data-repair job, not
      // something a backfill should quietly enrol in a country marketplace. A
      // non-empty set also blocks POST.
      skipped_unowned: s.linkPlan.skipped_unowned,
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

  const s = await survey(req, market)

  // ── VALIDATE (pure, and BEFORE any write) ────────────────────────────────
  const blocked_by = blockingReasons(s)
  if (blocked_by.length > 0 || !s.membership || !s.linkPlan || s.channel.status !== 'resolved') {
    return res.status(422).json({
      applied: false,
      market_code: market,
      // Every reason at once, not one failure at a time: a backfill run should not be
      // a sequence of surprises.
      blocked_by: blocked_by.length > 0 ? blocked_by : ['Marketplace channel unavailable for this market.'],
      unknown_market: s.sellerPlan.unknown,
    })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const salesChannelService: any = req.scope.resolve(Modules.SALES_CHANNEL)

  // ── APPLY 1: seller operating_market ──────────────────────────────────────
  // Re-read each seller immediately before writing. A read is not a claim: the plan
  // was computed from a list read, and `updateSellers` replaces the whole metadata
  // bag — a value written between the two would be clobbered. The re-read narrows the
  // window AND makes the apply idempotent: a seller that already has a value is
  // skipped, so a second run is a no-op rather than a rewrite.
  let sellersUpdated = 0
  let sellersSkipped = 0
  for (const update of s.sellerPlan.updates) {
    const [fresh] = await sellerService.listSellers({ id: update.id }, { take: 1 })
    if (!fresh) { sellersSkipped += 1; continue }
    if (readSellerOperatingMarket(fresh).source !== 'legacy_default') { sellersSkipped += 1; continue }
    await sellerService.updateSellers({
      id: fresh.id,
      metadata: setSellerOperatingMarket(fresh.metadata, market),
    })
    sellersUpdated += 1
  }

  // ── APPLY 2: link ONLY this market's sellers' products ────────────────────
  // Idempotent by construction: only ids missing the link are passed, and a product
  // owned by another market's seller — or by no resolvable seller — is never linked.
  if (s.linkPlan.link.length > 0) {
    await linkProductsToSalesChannelWorkflow(req.scope).run({
      input: { id: s.channel.id, add: s.linkPlan.link },
    })
  }

  // ── APPLY 3: cosmetic rename. Id unchanged. ───────────────────────────────
  let renamed = false
  if (market === 'mx' && s.channelRow && s.channelRow.name !== MX_MARKETPLACE_CHANNEL_NAME) {
    await salesChannelService.updateSalesChannels(s.channel.id, { name: MX_MARKETPLACE_CHANNEL_NAME })
    renamed = true
  }

  return res.json({
    applied: true,
    market_code: market,
    channel_id: s.channel.id,
    // Both scans were complete or we would not be here — stated explicitly so the
    // response is self-describing rather than implying completeness by omission.
    scan: { sellers: s.sellerScan, products: s.productScan },
    sellers_updated: sellersUpdated,
    sellers_skipped: sellersSkipped,
    products_linked: s.linkPlan.link.length,
    products_skipped_other_market: s.linkPlan.skipped_other_market.length,
    products_skipped_unowned: s.linkPlan.skipped_unowned.length,
    channel_renamed: renamed,
  })
}
