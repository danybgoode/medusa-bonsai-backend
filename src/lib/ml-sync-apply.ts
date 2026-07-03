/**
 * Atomic application of an ML sale to a linked Medusa product's inventory
 * (Sprint 4 · US-11/12; exactly-once storage upgraded to a durable table in
 * ml-orders-native S1 · US-0). Shared by the inbound webhook and the reconcile
 * job so the exactly-once decrement is defined once.
 *
 * Two correctness guarantees:
 *  - **Exactly-once** — a `getAppliedOrder` read-check + `recordAppliedOrder`
 *    write against the durable `ml_applied_order` table (`unique(link_id,
 *    ml_order_id)`), so concurrent deliveries (two webhooks, or a webhook racing
 *    the reconcile poll) are serialized per link with the Redis-backed **locking**
 *    module and re-checked inside the lock. The unique index is a SECOND layer,
 *    not a substitute for the lock: it stops a racing insert from creating a
 *    duplicate row/order, but only the lock actually holding prevents two
 *    concurrent callers from both decrementing stock before either inserts (see
 *    `isUniqueViolationError`'s doc comment in `sync-utils.ts`).
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
import { decideMlOrderApply, safeDecrement } from '../modules/mercadolibre/sync-utils'
import { getVariantInventoryItemId, resolveStockLocationId } from '../api/store/_utils/inventory'
import { materializeMlOrder } from './ml-order-materialize'
import type { MlOrder } from '../modules/mercadolibre/client'

type Scope = { resolve: (key: string) => any }
type LinkRef = { id: string; seller_id: string; product_id: string; variant_id?: string | null; ml_item_id: string }

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
 * `materializeMlOrder`, but NEVER throws — any error (a Medusa workflow
 * validation failure, a DB timeout, anything) degrades to `null`, exactly like
 * a graceful "couldn't resolve product/region" return. Both call sites below
 * are downstream of the stock decrement already having committed, so an
 * uncaught exception here would skip `recordAppliedOrder` entirely — leaving
 * NO row for a decrement that already happened, so the next retry would
 * decrement AGAIN. 2nd-round cross-review caught this gap.
 */
async function safeMaterialize(
  scope: Scope,
  link: LinkRef,
  sellerAccessToken: string,
  mlOrder: MlOrder,
): Promise<{ medusaOrderId: string } | null> {
  try {
    return await materializeMlOrder(scope, link, sellerAccessToken, mlOrder)
  } catch (e) {
    console.error('[ml-sync-apply] materializeMlOrder threw (non-fatal, degrading to null):', e)
    return null
  }
}

/**
 * Apply one ML order's sale of `quantity` units to `link`, exactly once,
 * atomically — the stock decrement always runs (S4); when `ordersEnabled` is
 * true AND this is a fresh apply (not a replay), it ALSO materializes a Medusa
 * order inside the same lock (ml-orders-native S1 · US-0/US-1) — never both a
 * decrement AND a duplicate order on replay, never an order without the
 * decrement that funded it. `mlOrder` (the full raw ML order) + `sellerAccessToken`
 * are only needed when `ordersEnabled` is true (materialization + its shipment
 * fetch); omit them on the flag-off path.
 */
export async function applyMlOrderToLink(
  scope: Scope,
  ml: MercadolibreModuleService,
  link: LinkRef,
  orderId: string,
  quantity: number,
  ordersEnabled = false,
  mlOrder?: MlOrder | null,
  sellerAccessToken?: string | null,
): Promise<ApplyResult> {
  const locking = scope.resolve(Modules.LOCKING)
  // The critical section holds ONLY the correctness writes (decrement + record +
  // materialize); the observability event is emitted AFTER the lock releases so a
  // slow log insert can never extend the lock hold (cross-review: keep side
  // effects out of the lock).
  const applied = await locking.execute(
    `ml-sync:${link.id}`,
    async (): Promise<
      { decremented: number; sellerId: string; mlItemId: string | null; medusaOrderId: string | null; retried: boolean } | null
    > => {
      // Re-read INSIDE the lock so the applied-order check reflects any concurrent
      // apply that already committed (US-0: durable table, not the metadata ring).
      const [fresh, existing] = await Promise.all([ml.getLink(link.id), ml.getAppliedOrder(link.id, orderId)])
      const decision = decideMlOrderApply(existing, ordersEnabled)
      if (decision.kind === 'skip') return null

      const sellerId = (fresh as { seller_id?: string } | null)?.seller_id ?? ''
      const mlItemId = (fresh as { ml_item_id?: string } | null)?.ml_item_id ?? null

      // Stock was already decremented on a prior pass (a row exists) — this pass
      // ONLY retries materialization (never a second decrement). Cross-review
      // caught a version of this function that had no recovery path here: a
      // transient/config failure on the FIRST materialization attempt would
      // otherwise permanently strand the sale order-less, forever, since the row
      // already existed and `decideMlOrderApply` used to treat any existing row
      // as a flat skip.
      if (decision.kind === 'retry-materialize') {
        if (!mlOrder || !sellerAccessToken) return null // can't retry without them → try again next pass
        const materialized = await safeMaterialize(scope, link, sellerAccessToken, mlOrder)
        if (!materialized) return null // still failing → try again next pass, no write
        await ml.setAppliedOrderMedusaId(decision.appliedOrderId, materialized.medusaOrderId)
        return { decremented: 0, sellerId, mlItemId, medusaOrderId: materialized.medusaOrderId, retried: true }
      }

      const decremented =
        quantity > 0 ? await decrementProductStock(scope, link.product_id, link.variant_id, quantity) : 0
      if (decremented == null) return null // couldn't resolve inventory → retry, do NOT mark

      // The decrement is now a REAL, committed inventory mutation — from here on
      // we MUST record the row no matter what, or a retry would decrement again
      // (the exact double-apply bug this table exists to prevent). `safeMaterialize`
      // never throws (2nd-round cross-review caught a version where an uncaught
      // workflow exception here would skip `recordAppliedOrder` entirely, leaving
      // NO row for a decrement that already happened — the next retry would
      // decrement again) — any failure, thrown or graceful, degrades to
      // `medusaOrderId: null` rather than aborting the write; the NEXT pass then
      // takes the `retry-materialize` branch above instead of losing the order.
      let medusaOrderId: string | null = null
      if (decision.materializeOrder && mlOrder && sellerAccessToken) {
        const materialized = await safeMaterialize(scope, link, sellerAccessToken, mlOrder)
        medusaOrderId = materialized?.medusaOrderId ?? null
      }

      await ml.recordAppliedOrder(link.id, orderId, { inventoryDelta: decremented, medusaOrderId })
      return { decremented, sellerId, mlItemId, medusaOrderId, retried: false }
    },
    // Order materialization adds a shipment fetch + a DB write inside the lock —
    // give it more headroom than the stock-only path.
    { timeout: ordersEnabled && mlOrder ? 15 : 5 },
  )

  if (!applied) return 'skipped'

  // Best-effort activity-log write, outside the lock. Never affects correctness.
  await ml.recordSyncEvent({
    sellerId: applied.sellerId,
    kind: 'sale_applied',
    outcome: 'ok',
    productId: link.product_id,
    mlItemId: applied.mlItemId,
    code: orderId,
    // `retried` = stock was already decremented on a prior pass; this pass only
    // materialized the order, so the message must not imply a fresh -N decrement
    // (cross-review nit — "-0" on a retry misleadingly read as "nothing moved").
    message: applied.retried
      ? `Pedido de Mercado Libre materializado (venta ya aplicada previamente): orden ${orderId}, pedido ${applied.medusaOrderId}`
      : applied.medusaOrderId
        ? `Venta de Mercado Libre aplicada: -${applied.decremented} (orden ${orderId}, pedido ${applied.medusaOrderId})`
        : `Venta de Mercado Libre aplicada: -${applied.decremented} (orden ${orderId})`,
    metadata: { sold: quantity, decremented: applied.decremented, medusa_order_id: applied.medusaOrderId, retried: applied.retried },
  })
  return 'applied'
}
