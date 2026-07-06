/**
 * Apply an ML cancellation/refund to an already-materialized order (ml-orders-
 * native S2 · US-4): restock exactly `inventory_delta` units, then cancel the
 * Medusa order. Called only from `reconcile-ml-order-status.ts`, after
 * `decideMlOrderCancel` (the pure decision, in `sync-utils.ts`) says
 * `restock-and-cancel`.
 *
 * Runs inside the SAME per-link Redis lock (`ml-sync:${linkId}`) Sprint 1's
 * `applyMlOrderToLink` already uses for the decrement/materialize pair, so a
 * cancel can never race a fresh apply of the same link. Re-checks
 * `cancelled_at` INSIDE the lock (mirrors `applyMlOrderToLink`'s re-read
 * pattern) so two overlapping reconcile passes can't both restock.
 *
 * The restock itself is the first POSITIVE `adjustInventory` call in the ML
 * sync pipeline — the mirror image of `decrementProductStock` in
 * `ml-sync-apply.ts`. `cancelOrdersStep` is composed directly rather than the
 * full `cancelOrderWorkflow`: that workflow's own validation
 * (`cancelValidateOrder`) throws "Cannot cancel a completed order," and every
 * ML-materialized order is created with `status: 'completed'` (no Miyagi
 * payment_collection to refund either — ML buyers pay Mercado Libre directly).
 * Same precedent Sprint 1 already established for `createOrdersStep` over
 * `createOrderWorkflow`.
 */

import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { createWorkflow, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { cancelOrdersStep } from '@medusajs/medusa/core-flows'
import type MercadolibreModuleService from '../modules/mercadolibre/service'
import { getVariantInventoryItemId, resolveStockLocationId } from '../api/store/_utils/inventory'

type Scope = { resolve: (key: string) => any }

const cancelMlOrderWorkflow = createWorkflow('ml-cancel-order', (input: { orderIds: string[] }) => {
  const canceled = cancelOrdersStep(input)
  return new WorkflowResponse(canceled)
})

export type CancelApplyResult = 'cancelled' | 'skipped'

/**
 * Restock + cancel one applied-order row. Returns `'skipped'` (never throws) if
 * the row was already cancelled by a concurrent pass, or if the link/inventory
 * can't be resolved (a config/data gap — the next reconcile pass retries,
 * mirroring `decrementProductStock`'s null-means-retry contract).
 */
export async function applyMlOrderCancel(
  scope: Scope,
  ml: MercadolibreModuleService,
  appliedOrderId: string,
  linkId: string,
  medusaOrderId: string,
  restockQty: number,
): Promise<CancelApplyResult> {
  const locking = scope.resolve(Modules.LOCKING)
  const result = await locking.execute(
    `ml-sync:${linkId}`,
    async (): Promise<'cancelled' | 'skipped'> => {
      // Re-read INSIDE the lock (mirrors `applyMlOrderToLink`'s re-read) so a
      // concurrent pass that already cancelled this row is seen here, not raced.
      const current = await ml.getAppliedOrderByMedusaOrderId(medusaOrderId)
      if (!current || current.cancelled_at) return 'skipped' // already handled by a concurrent pass

      const link = await ml.getLink(linkId)
      if (!link) return 'skipped' // link deleted/unresolvable → nothing to restock against

      if (restockQty > 0) {
        const query = scope.resolve(ContainerRegistrationKeys.QUERY)
        let variantId = (link as { variant_id?: string | null }).variant_id ?? undefined
        if (!variantId) {
          const { data } = await query.graph({
            entity: 'product',
            fields: ['variants.id'],
            filters: { id: (link as { product_id: string }).product_id },
          })
          const variants = ((data?.[0] as any)?.variants ?? []) as { id?: string }[]
          if (variants.length > 1) {
            // Multi-variant (configurator) product with no linked variant_id —
            // silently restocking variants[0] could credit the wrong combination.
            console.error('[cancelMlOrderApply] no variant_id but product has multiple variants — refusing to guess', {
              productId: (link as { product_id: string }).product_id,
            })
          } else {
            variantId = variants[0]?.id
          }
        }
        if (!variantId) return 'skipped'
        const inventoryItemId = await getVariantInventoryItemId(scope, variantId)
        if (!inventoryItemId) return 'skipped'
        const locationId = await resolveStockLocationId(scope)
        if (!locationId) return 'skipped'

        const inventoryService = scope.resolve(Modules.INVENTORY)
        await inventoryService.adjustInventory(inventoryItemId, locationId, restockQty)
      }

      await cancelMlOrderWorkflow(scope as any).run({ input: { orderIds: [medusaOrderId] } })
      await ml.setAppliedOrderCancelled(appliedOrderId)
      return 'cancelled'
    },
    { timeout: 10 },
  )
  return result ?? 'skipped'
}
