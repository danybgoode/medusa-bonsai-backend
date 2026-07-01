/**
 * Atomic application of an ML sale to a linked Medusa product's inventory
 * (Sprint 4 · US-11/12). Shared by the inbound webhook and the reconcile job so
 * the exactly-once decrement is defined once.
 *
 * Two correctness guarantees:
 *  - **Exactly-once** — the applied-order ring + the decrement are a
 *    read-check-write, so concurrent deliveries (two webhooks, or a webhook racing
 *    the reconcile poll) are serialized per link with the Redis-backed **locking**
 *    module and re-checked inside the lock.
 *  - **Oversell-safe decrement** — an ML sale is a **relative** reduction of
 *    `stocked_quantity` (`adjustInventory(-n)`), NOT an absolute set of available.
 *    A relative stocked decrement composes with a concurrent Miyagi reservation
 *    (which changes `reserved`, a different field); an absolute available-set would
 *    clobber that reservation and leave stock too high. The decrement is capped at
 *    the current available (`safeDecrement`) so available never goes negative.
 *
 * NOTE (scope): the linkage is per-product and these marketplace goods are
 * single-variant, so decrementing the linked variant's stock is the product's
 * stock. True multi-variant ML mapping is out of S4 scope (S5).
 */

import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import type MercadolibreModuleService from '../modules/mercadolibre/service'
import { isOrderApplied, safeDecrement, type AppliedOrder } from '../modules/mercadolibre/sync-utils'
import { getVariantInventoryItemId, resolveStockLocationId } from '../api/store/_utils/inventory'

type Scope = { resolve: (key: string) => any }
type LinkRef = { id: string; product_id: string; variant_id?: string | null }

export type ApplyResult = 'applied' | 'skipped'

/** Decrement a linked product's physical stock by an ML sale (relative, reservation-safe). */
async function decrementProductStock(
  scope: Scope,
  productId: string,
  variantId: string | null | undefined,
  soldQty: number,
): Promise<number> {
  const qty = Math.max(0, Math.floor(soldQty))
  if (qty === 0) return 0
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  let vId = variantId ?? undefined
  if (!vId) {
    const { data } = await query.graph({ entity: 'product', fields: ['variants.id'], filters: { id: productId } })
    vId = ((data?.[0] as any)?.variants?.[0] as { id?: string } | undefined)?.id
  }
  if (!vId) return 0
  const inventoryItemId = await getVariantInventoryItemId(scope, vId)
  if (!inventoryItemId) return 0
  const locationId = await resolveStockLocationId(scope)
  if (!locationId) return 0

  const inventoryService = scope.resolve(Modules.INVENTORY)
  const [level] = await inventoryService.listInventoryLevels({
    inventory_item_id: inventoryItemId,
    location_id: locationId,
  })
  const decrement = safeDecrement(Number(level?.stocked_quantity ?? 0), Number(level?.reserved_quantity ?? 0), qty)
  if (decrement <= 0) return 0
  await inventoryService.adjustInventory(inventoryItemId, locationId, -decrement)
  return decrement
}

/**
 * Apply one ML order's sale of `quantity` units to `link`, exactly once, atomically.
 * Records the order id in the ring only — the outbound mirror (`pushStockToMl`) owns
 * `last_pushed_available`, so an ML sale doesn't stamp a baseline that could make a
 * later real push skip.
 */
export async function applyMlOrderToLink(
  scope: Scope,
  ml: MercadolibreModuleService,
  link: LinkRef,
  orderId: string,
  quantity: number,
): Promise<ApplyResult> {
  const locking = scope.resolve(Modules.LOCKING)
  return locking.execute(
    `ml-sync:${link.id}`,
    async () => {
      // Re-read the link INSIDE the lock so the applied-order check reflects any
      // concurrent apply that already committed.
      const fresh = await ml.getLink(link.id)
      const meta = (fresh?.metadata ?? {}) as Record<string, unknown>
      if (isOrderApplied(meta.ml_applied_orders as AppliedOrder[] | undefined, orderId)) return 'skipped'

      if (quantity > 0) await decrementProductStock(scope, link.product_id, link.variant_id, quantity)
      await ml.markOrderApplied(link.id, orderId) // exactly-once; no baseline write
      return quantity > 0 ? 'applied' : 'skipped'
    },
    { timeout: 5 },
  )
}
