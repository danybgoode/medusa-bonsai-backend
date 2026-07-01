/**
 * Atomic application of an ML sale to a linked Medusa product's inventory
 * (Sprint 4 · US-11/12). Shared by the inbound webhook and the reconcile job so
 * the exactly-once decrement is defined once.
 *
 * The idempotency guard (applied-order ring) + the inventory decrement are a
 * read-check-write, so concurrent deliveries (two webhooks, or a webhook racing
 * the reconcile poll) could otherwise both see the order as unapplied and both
 * decrement. We serialize per link with the Redis-backed **locking** module and
 * **re-check inside the lock** — the second caller sees it applied and no-ops.
 *
 * NOTE (scope): the linkage is per-product; these marketplace goods are
 * single-variant, so `getProductAvailableQuantity` (summed) equals the linked
 * variant's stock. True multi-variant ML mapping is out of S4 scope (S5).
 */

import { Modules } from '@medusajs/framework/utils'
import type MercadolibreModuleService from '../modules/mercadolibre/service'
import { applySale, isOrderApplied, type AppliedOrder } from '../modules/mercadolibre/sync-utils'
import { getProductAvailableQuantity, setProductAvailableQuantity } from '../api/store/_utils/inventory'

type Scope = { resolve: (key: string) => any }
type LinkRef = { id: string; product_id: string; variant_id?: string | null }

export type ApplyResult = 'applied' | 'skipped' | 'no_inventory'

/** Apply one ML order's sale of `quantity` units to `link`, exactly once, atomically. */
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

      if (quantity <= 0) {
        await ml.markOrderApplied(link.id, orderId) // record only; no stock change, no baseline write
        return 'skipped'
      }

      const current = await getProductAvailableQuantity(scope, link.product_id)
      if (current == null) return 'no_inventory'
      const next = applySale(current, quantity)
      await setProductAvailableQuantity(scope, link.product_id, link.variant_id, next)
      await ml.markOrderAppliedForLink(link.id, orderId, next)
      return 'applied'
    },
    { timeout: 5 },
  )
}
