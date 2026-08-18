/**
 * PATCH /store/sellers/me/orders/bulk-status
 *
 * Advance several orders' fulfillment status in one call (ml-orders-native S3 ·
 * US-8 — batch days). Status-only transitions (no bulk carrier/tracking entry —
 * mirrors what the single-order PATCH already supports with just {status}; a
 * bulk "ship with a label" isn't in scope). Reuses the exact same
 * `applyOrderStatusTransition` the single-order route composes
 * (`lib/order-status-transition.ts`) — source-agnostic by construction, so
 * mixed ML + native selections need no special-casing.
 *
 * Per-order try/catch (mirrors `jobs/reconcile-ml-order-status.ts`'s partial-
 * failure idiom) — one order's failure/ineligibility never aborts the batch.
 *
 * Body: { order_ids: string[], status: 'processing' | 'shipped' | 'delivered' }
 * Response: { advanced: string[], skipped: [{ order_id, reason }] }
 *
 * Auth: Clerk JWT — only orders containing this seller's products are touched.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { resolveSeller } from '../../../../_utils/clerk-auth'
import {
  resolveSellerProductIds,
  sellerOwnsEveryOrderItem,
} from '../../../../_utils/seller-catalog-query'
import { applyOrderStatusTransition } from '../../../../../../lib/order-status-transition'
import {
  BULK_ALLOWED_STATUSES,
  MAX_BULK_ORDERS,
  parseBulkStatusRequest,
} from '../_utils/bulk-status-contract'

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const seller = await resolveSeller(req)
  if (!seller) return res.status(401).json({ message: 'Unauthorized' })

  const { orderIds, newStatus, expectedStatuses } = parseBulkStatusRequest(req.body)

  if (!orderIds.length) return res.status(400).json({ message: 'Se requiere order_ids.' })
  if (orderIds.length > MAX_BULK_ORDERS) {
    return res.status(400).json({ message: `No se pueden actualizar más de ${MAX_BULK_ORDERS} pedidos a la vez.` })
  }
  if (!newStatus || !BULK_ALLOWED_STATUSES.has(newStatus)) {
    return res.status(422).json({ message: `Estado de lote no compatible: ${newStatus}` })
  }

  const orderService = req.scope.resolve(Modules.ORDER) as any

  // Resolve the seller's product IDs ONCE for the whole batch (not per order).
  const sellerProductIds = await resolveSellerProductIds(
    req.scope,
    seller.sellerId,
  )

  const advanced: string[] = []
  const skipped: Array<{ order_id: string; reason: string }> = []

  for (const orderId of orderIds) {
    try {
      const order = await orderService.retrieveOrder(orderId, {
        select: ['id', 'status', 'payment_status', 'fulfillment_status', 'metadata'],
        relations: ['items', 'fulfillments'],
      }).catch(() => null)

      if (!order) {
        skipped.push({ order_id: orderId, reason: 'Pedido no encontrado o no disponible.' })
        continue
      }

      if (!sellerOwnsEveryOrderItem(sellerProductIds, order.items)) {
        skipped.push({ order_id: orderId, reason: 'Pedido no encontrado o no disponible.' })
        continue
      }

      const result = await applyOrderStatusTransition(req.scope, {
        orderId,
        order,
        newStatus,
        expectedStatus: expectedStatuses[orderId],
      })
      if (!result.ok) {
        skipped.push({ order_id: orderId, reason: result.message })
        continue
      }
      advanced.push(orderId)
    } catch (e) {
      console.error('[bulk-status] order failed:', orderId, e)
      skipped.push({ order_id: orderId, reason: 'Error inesperado al actualizar.' })
    }
  }

  return res.json({ advanced, skipped })
}
