/**
 * POST /internal/backfill-inventory
 *
 * One-time (idempotent) backfill that brings existing seller products onto the
 * Medusa Inventory module. For every stockable physical `product` listing whose
 * variant is still `manage_inventory: false`, it:
 *   1. flips the variant to `manage_inventory: true`,
 *   2. ensures a linked inventory item (created here — flipping the flag on an
 *      existing variant does NOT auto-create one),
 *   3. creates a stock level (default qty 1) at its seller market's configured
 *      location, and
 *   4. links that location to that market's marketplace + operating channels so
 *      reservations succeed without crossing market rails.
 *
 * Non-stockable listings (service/rental/digital/subscription) are left untouched.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 * Body (optional): { quantity?: number (default 1), dry_run?: boolean, limit?: number }
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { internalSecretOk } from '../../../lib/internal-auth'
import { SELLER_MODULE } from '../../../modules/seller'
import type SellerModuleService from '../../../modules/seller/service'
import { readSellerOperatingMarket } from '../../../lib/seller-market'
import { resolveChannelIdsForMarket } from '../../../lib/market-medusa'
import type { MarketCode } from '../../../lib/markets'
import { resolveSellerProductIds } from '../../store/_utils/seller-catalog-query'
import {
  isStockableListingType,
  resolveStockLocationId,
  ensureVariantInventoryItem,
  ensureInventoryLevel,
  ensureSalesChannelLocationLink,
} from '../../store/_utils/inventory'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  // Fail CLOSED on a missing secret — see src/lib/internal-auth.ts.
  if (!internalSecretOk(req)) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const body = (req.body ?? {}) as { quantity?: number; dry_run?: boolean; limit?: number }
  const quantity = Math.max(0, Math.floor(body.quantity ?? 1))
  const dryRun = body.dry_run === true
  const limit = Math.min(Number(body.limit) || 5000, 5000)

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const productService = req.scope.resolve(Modules.PRODUCT) as any

  // ── Load products with variants + type ────────────────────────────────────
  const { data: products } = await query.graph({
    entity: 'product',
    fields: [
      'id', 'metadata', 'type.value',
      'variants.id', 'variants.sku', 'variants.title', 'variants.manage_inventory',
    ],
    pagination: { take: limit + 1, skip: 0 },
  })
  if ((products?.length ?? 0) > limit) {
    return res.status(409).json({ message: `Product survey exceeded limit ${limit}; refusing a truncated backfill.` })
  }

  // Prove ownership and market for the complete population before the first
  // channel, variant, item, or level write. Platform/orphan products are excluded;
  // ambiguous ownership, invalid seller market, or unreadable links block all.
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const sellers = await sellerService.listSellers({}, { take: 2001 })
  if (sellers.length > 2000) return res.status(409).json({ message: 'Seller survey exceeded 2000; refusing a truncated backfill.' })
  const ownerMarket = new Map<string, MarketCode>()
  const blockers: string[] = []
  for (const seller of sellers as any[]) {
    const market = readSellerOperatingMarket(seller)
    if (!market.market) {
      blockers.push(`Seller ${seller.id} has an invalid operating market.`)
      continue
    }
    let productIds: Set<string>
    try {
      productIds = await resolveSellerProductIds(req.scope, seller.id)
    } catch (e) {
      blockers.push(`Seller ${seller.id} product ownership is unavailable: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    for (const productId of productIds) {
      if (ownerMarket.has(productId)) blockers.push(`Product ${productId} has ambiguous seller ownership.`)
      else ownerMarket.set(productId, market.market)
    }
  }

  const rails = new Map<MarketCode, { locationId: string; channelIds: string[] }>()
  for (const market of new Set(ownerMarket.values())) {
    const locationId = await resolveStockLocationId(req.scope, market)
    const channels = resolveChannelIdsForMarket(market, process.env)
    const channelIds = [channels.marketplace_channel_id, channels.operating_channel_id]
      .filter((id): id is string => !!id)
    if (!locationId) blockers.push(`No stock location is configured for owned market ${market}.`)
    if (!channels.marketplace_channel_id || !channels.operating_channel_id) {
      blockers.push(`Both marketplace and operating Sales Channels must be configured for owned market ${market}.`)
    }
    if (locationId && channelIds.length === 2) rails.set(market, { locationId, channelIds })
  }
  if (blockers.length > 0) return res.status(409).json({ message: 'Inventory backfill preflight blocked.', blocked_by: blockers })

  const summary = {
    scanned: products?.length ?? 0,
    stockable: 0,
    flipped: 0,
    items_created: 0,
    levels_created: 0,
    skipped_already_managed: 0,
    skipped_non_stockable: 0,
    errors: [] as Array<{ product_id: string; error: string }>,
    skipped_unowned: 0,
    dry_run: dryRun,
  }

  // All blockers were evaluated above. Link each market's two channels before
  // variant writes so reservations use the same market location as stock levels.
  if (!dryRun) {
    for (const { locationId, channelIds } of rails.values()) {
      for (const channelId of channelIds) {
        await ensureSalesChannelLocationLink(req.scope, channelId, locationId)
      }
    }
  }

  for (const product of (products ?? []) as any[]) {
    const market = ownerMarket.get(product.id)
    if (!market) {
      summary.skipped_unowned++
      continue
    }
    const locationId = rails.get(market)!.locationId
    const listingType = (product.type?.value ?? (product.metadata?.listing_type as string | undefined) ?? 'product')
    if (!isStockableListingType(listingType)) {
      summary.skipped_non_stockable++
      continue
    }
    summary.stockable++

    const variant = product.variants?.[0] as
      | { id: string; sku?: string | null; title?: string | null; manage_inventory?: boolean }
      | undefined
    if (!variant) continue

    if (dryRun) continue

    try {
      if (!variant.manage_inventory) {
        await productService.updateProductVariants(variant.id, { manage_inventory: true })
        summary.flipped++
      } else {
        summary.skipped_already_managed++
      }

      const before = await query.graph({
        entity: 'variant',
        fields: ['id', 'inventory_items.inventory_item_id'],
        filters: { id: variant.id },
      })
      const hadItem = !!(before.data?.[0]?.inventory_items?.[0]?.inventory_item_id)

      const inventoryItemId = await ensureVariantInventoryItem(req.scope, variant)
      if (!hadItem) summary.items_created++

      const inventoryService = req.scope.resolve(Modules.INVENTORY)
      const existingLevels = await inventoryService.listInventoryLevels({
        inventory_item_id: inventoryItemId,
        location_id: locationId,
      })
      if (existingLevels.length === 0) {
        await ensureInventoryLevel(req.scope, inventoryItemId, locationId, quantity)
        summary.levels_created++
      }
    } catch (e) {
      summary.errors.push({
        product_id: product.id,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return res.json(summary)
}
