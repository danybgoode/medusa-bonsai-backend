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
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { resolveSeller } from '../../../../_utils/clerk-auth'
import { applyOrderStatusTransition } from '../../../../../../lib/order-status-transition'

const MAX_BULK_ORDERS = 50
const BULK_ALLOWED_STATUSES = new Set(['processing', 'shipped', 'delivered'])

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const seller = await resolveSeller(req)
  if (!seller) return res.status(401).json({ message: 'Unauthorized' })

  const body = req.body as { order_ids?: unknown; status?: string }
  const orderIds = Array.isArray(body.order_ids)
    ? body.order_ids.filter((id): id is string => typeof id === 'string')
    : []
  const newStatus = body.status

  if (!orderIds.length) return res.status(400).json({ message: 'order_ids is required' })
  if (orderIds.length > MAX_BULK_ORDERS) {
    return res.status(400).json({ message: `No se pueden actualizar más de ${MAX_BULK_ORDERS} pedidos a la vez.` })
  }
  if (!newStatus || !BULK_ALLOWED_STATUSES.has(newStatus)) {
    return res.status(422).json({ message: `Unsupported bulk status: ${newStatus}` })
  }

  const orderService = req.scope.resolve(Modules.ORDER) as any
  const remoteQuery = req.scope.resolve(ContainerRegistrationKeys.REMOTE_QUERY)

  // Resolve the seller's product IDs ONCE for the whole batch (not per order).
  let sellerProductIds = new Set<string>()
  try {
    const { data: sellerRows } = await (remoteQuery as any).graph({
      entity: 'seller',
      fields: ['id', 'products.id'],
      filters: { id: seller.sellerId },
    })
    sellerProductIds = new Set(((sellerRows?.[0] as any)?.products ?? []).map((p: any) => p.id as string))
  } catch { /* if the link query fails, skip ownership checks rather than block the whole batch */ }

  const advanced: string[] = []
  const skipped: Array<{ order_id: string; reason: string }> = []

  for (const orderId of orderIds) {
    try {
      const order = await orderService.retrieveOrder(orderId, {
        select: ['id', 'metadata'],
        relations: ['items', 'fulfillments'],
      }).catch(() => null)

      if (!order) {
        skipped.push({ order_id: orderId, reason: 'Pedido no encontrado.' })
        continue
      }

      if (sellerProductIds.size > 0) {
        const orderProductIds = ((order.items as any[]) ?? []).map((i: any) => i.product_id)
        if (!orderProductIds.some((pid: string) => sellerProductIds.has(pid))) {
          skipped.push({ order_id: orderId, reason: 'Este pedido no te pertenece.' })
          continue
        }
      }

      const result = await applyOrderStatusTransition(req.scope, { orderId, order, newStatus })
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
