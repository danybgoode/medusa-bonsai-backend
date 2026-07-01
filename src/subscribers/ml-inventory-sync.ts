/**
 * ML stock sync · outbound (Sprint 4 · US-10) — a Miyagi sale pushes the new
 * available quantity to the linked Mercado Libre item, so ML never oversells.
 *
 * Why `order.placed` (not an `inventory-level.updated` subscriber): in Medusa v2
 * a sale reduces *available* by creating a **reservation** (reserved_quantity ↑),
 * not by writing a stocked level — and the inventory module does not emit a
 * level-changed event anyway (`InventoryEvents.updated` is defined but never
 * emitted by the update/adjust flows). `order.placed` is the guaranteed, exactly-
 * once signal that stock was consumed. Seller *manual* stock edits push from the
 * seller-product-update path; the reconcile job is the catch-all safety net.
 *
 * Gated by the global `ml.sync_enabled` kill-switch here; the per-seller enable +
 * linkage + idempotency (skip-if-unchanged) + rate-limit deferral all live inside
 * `pushStockToMl`. Best-effort per product — one failure never blocks the order.
 */

import type { SubscriberArgs, SubscriberConfig } from '@medusajs/framework'
import { Modules } from '@medusajs/framework/utils'
import { IOrderModuleService } from '@medusajs/framework/types'
import { isEnabled } from '../lib/flags'
import { MERCADOLIBRE_MODULE } from '../modules/mercadolibre'
import MercadolibreModuleService from '../modules/mercadolibre/service'
import { getProductAvailableQuantity } from '../api/store/_utils/inventory'

export default async function mlInventorySync({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  // Global kill-switch (fail-closed): a Flagsmith outage halts sync.
  if (!(await isEnabled('ml.sync_enabled'))) return

  const orderService = container.resolve(Modules.ORDER) as IOrderModuleService
  const order = await orderService.retrieveOrder(data.id, { relations: ['items'] })
  const items = (order.items ?? []) as { product_id?: string | null }[]

  // One push per distinct product (a burst of line items for the same product
  // collapses; pushStockToMl is itself idempotent on the resulting quantity).
  const productIds = [...new Set(items.map((i) => i.product_id).filter((id): id is string => !!id))]
  if (productIds.length === 0) return

  const ml = container.resolve(MERCADOLIBRE_MODULE) as MercadolibreModuleService

  for (const productId of productIds) {
    try {
      const available = await getProductAvailableQuantity(container as never, productId)
      if (available == null) continue // no managed inventory to sync
      await ml.pushStockToMl({ productId, availableQuantity: available })
    } catch (e) {
      // Never let an ML hiccup affect order placement; the reconcile job heals it.
      console.error('[ml-inventory-sync] push failed for product', productId, e)
    }
  }
}

export const config: SubscriberConfig = {
  event: 'order.placed',
}
