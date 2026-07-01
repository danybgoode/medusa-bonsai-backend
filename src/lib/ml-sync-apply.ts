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

/**
 * Decrement a linked product's physical stock by an ML sale (relative,
 * reservation-safe). Returns the units decremented, or **null** when the inventory
 * item / stock location couldn't be resolved (a transient/config gap) — the caller
 * must NOT mark the order applied in that case, so the reconcile poll retries it
 * rather than permanently losing the decrement (which would overstate stock).
 */
async function decrementProductStock(
  scope: Scope,
  productId: string,
  variantId: string | null | undefined,
  soldQty: number,
): Promise<number | null> {
  const qty = Math.max(0, Math.floor(soldQty))
  if (qty === 0) return 0
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  let vId = variantId ?? undefined
  if (!vId) {
    const { data } = await query.graph({ entity: 'product', fields: ['variants.id'], filters: { id: productId } })
    vId = ((data?.[0] as any)?.variants?.[0] as { id?: string } | undefined)?.id
  }
  if (!vId) return null // unresolved → retry, don't mark applied
  const inventoryItemId = await getVariantInventoryItemId(scope, vId)
  if (!inventoryItemId) return null
  const locationId = await resolveStockLocationId(scope)
  if (!locationId) return null

  const inventoryService = scope.resolve(Modules.INVENTORY)
  const [level] = await inventoryService.listInventoryLevels({
    inventory_item_id: inventoryItemId,
    location_id: locationId,
  })
  // Resolved: a decrement capped at available (0 if already sold out on our side) is
  // still "done" — the shortfall vs soldQty is a real cross-channel discrepancy, not
  // something a retry can fix — so we return a number (≥ 0) and the caller marks it.
  const decrement = safeDecrement(Number(level?.stocked_quantity ?? 0), Number(level?.reserved_quantity ?? 0), qty)
  if (decrement > 0) await inventoryService.adjustInventory(inventoryItemId, locationId, -decrement)
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

      if (quantity > 0) {
        const decremented = await decrementProductStock(scope, link.product_id, link.variant_id, quantity)
        if (decremented == null) return 'skipped' // couldn't resolve inventory → retry, do NOT mark
        await ml.markOrderApplied(link.id, orderId)
        await ml.recordSyncEvent({
          sellerId: (fresh as { seller_id?: string } | null)?.seller_id ?? '',
          kind: 'sale_applied',
          outcome: 'ok',
          productId: link.product_id,
          mlItemId: (fresh as { ml_item_id?: string } | null)?.ml_item_id ?? null,
          code: orderId,
          message: `Venta de Mercado Libre aplicada: -${decremented} (orden ${orderId})`,
          metadata: { sold: quantity, decremented },
        })
        return 'applied'
      }
      await ml.markOrderApplied(link.id, orderId) // zero-qty line: record exactly-once, no stock change
      return 'skipped'
    },
    { timeout: 5 },
  )
}
