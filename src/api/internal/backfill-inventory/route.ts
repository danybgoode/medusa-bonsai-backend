/**
 * POST /internal/backfill-inventory
 *
 * One-time (idempotent) backfill that brings existing seller products onto the
 * Medusa Inventory module. For every stockable physical `product` listing whose
 * variant is still `manage_inventory: false`, it:
 *   1. flips the variant to `manage_inventory: true`,
 *   2. ensures a linked inventory item (created here — flipping the flag on an
 *      existing variant does NOT auto-create one),
 *   3. creates a stock level (default qty 1) at the seeded location, and
 *   4. links that location to the store's default sales channel so reservations
 *      succeed at checkout.
 *
 * Non-stockable listings (service/rental/digital/subscription) are left untouched.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 * Body (optional): { quantity?: number (default 1), dry_run?: boolean, limit?: number }
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import {
  isStockableListingType,
  resolveStockLocationId,
  ensureVariantInventoryItem,
  ensureInventoryLevel,
  ensureSalesChannelLocationLink,
} from '../../store/_utils/inventory'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const internalSecret = process.env.MEDUSA_INTERNAL_SECRET
  const headerSecret = req.headers['x-internal-secret'] as string | undefined
  if (internalSecret && headerSecret !== internalSecret) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const body = (req.body ?? {}) as { quantity?: number; dry_run?: boolean; limit?: number }
  const quantity = Math.max(0, Math.floor(body.quantity ?? 1))
  const dryRun = body.dry_run === true
  const limit = Math.min(Number(body.limit) || 5000, 5000)

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const productService = req.scope.resolve(Modules.PRODUCT) as any

  // ── Resolve location + default sales channel ──────────────────────────────
  const locationId = await resolveStockLocationId(req.scope)
  if (!locationId) {
    return res.status(500).json({ message: 'No stock location found' })
  }

  let salesChannelId: string | undefined = process.env.MEDUSA_SALES_CHANNEL_ID || undefined
  if (!salesChannelId) {
    try {
      const storeService: any = req.scope.resolve(Modules.STORE)
      const [store] = await storeService.listStores({}, { select: ['default_sales_channel_id'], take: 1 })
      salesChannelId = store?.default_sales_channel_id ?? undefined
    } catch (e) {
      console.error('[backfill-inventory] sales channel resolve failed:', e)
    }
  }

  // ── Load products with variants + type ────────────────────────────────────
  const { data: products } = await query.graph({
    entity: 'product',
    fields: [
      'id', 'metadata', 'type.value',
      'variants.id', 'variants.sku', 'variants.title', 'variants.manage_inventory',
    ],
    pagination: { take: limit, skip: 0 },
  })

  const summary = {
    scanned: products?.length ?? 0,
    stockable: 0,
    flipped: 0,
    items_created: 0,
    levels_created: 0,
    skipped_already_managed: 0,
    skipped_non_stockable: 0,
    errors: [] as Array<{ product_id: string; error: string }>,
    dry_run: dryRun,
  }

  // Link the buyer-facing sales channel to the location once (idempotent).
  if (!dryRun && salesChannelId) {
    try {
      await ensureSalesChannelLocationLink(req.scope, salesChannelId, locationId)
    } catch (e) {
      console.error('[backfill-inventory] SC↔location link failed:', e)
    }
  }

  for (const product of (products ?? []) as any[]) {
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
