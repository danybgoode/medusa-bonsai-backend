/**
 * POST /store/sellers/me/orders/bulk-status/preview
 *
 * Read-only transition ledger. Authentication and per-order ownership are
 * re-established here and again by PATCH; this response is never authority.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { resolveSeller } from '../../../../../_utils/clerk-auth'
import {
  resolveSellerProductIds,
  sellerOwnsEveryOrderItem,
} from '../../../../../_utils/seller-catalog-query'
import { planOrderStatusTransition } from '../../../../../../../lib/order-status-transition'
import {
  BULK_ALLOWED_STATUSES,
  MAX_BULK_ORDERS,
  parseBulkStatusRequest,
} from '../../_utils/bulk-status-contract'

const UNAVAILABLE_REASON = 'Pedido no encontrado o no disponible.'

type PreviewRow = {
  order_id: string
  title: string | null
  current_status: string | null
  proposed_status: string
  eligible: boolean
  reason: string | null
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const seller = await resolveSeller(req)
  if (!seller) return res.status(401).json({ message: 'Unauthorized' })

  const { orderIds, newStatus } = parseBulkStatusRequest(req.body)
  if (!orderIds.length) return res.status(400).json({ message: 'Se requiere order_ids.' })
  if (orderIds.length > MAX_BULK_ORDERS) {
    return res.status(400).json({ message: `No se pueden previsualizar más de ${MAX_BULK_ORDERS} pedidos a la vez.` })
  }
  if (!newStatus || !BULK_ALLOWED_STATUSES.has(newStatus)) {
    return res.status(422).json({ message: `Estado de lote no compatible: ${newStatus}` })
  }

  const orderService = req.scope.resolve(Modules.ORDER) as any
  const sellerProductIds = await resolveSellerProductIds(req.scope, seller.sellerId)
  const plans: PreviewRow[] = []

  for (const orderId of orderIds) {
    try {
      const order = await orderService.retrieveOrder(orderId, {
        select: ['id', 'status', 'payment_status', 'fulfillment_status', 'metadata'],
        relations: ['items', 'fulfillments'],
      }).catch(() => null)
      if (!order || !sellerOwnsEveryOrderItem(sellerProductIds, order.items)) {
        plans.push({
          order_id: orderId,
          title: null,
          current_status: null,
          proposed_status: newStatus,
          eligible: false,
          reason: UNAVAILABLE_REASON,
        })
        continue
      }

      const firstTitle = (order.items as Array<{ title?: unknown }> | undefined)?.find((item) => typeof item.title === 'string')?.title
      const initialPlan = planOrderStatusTransition({ order, newStatus })
      const plan = planOrderStatusTransition({
        order,
        newStatus,
        expectedStatus: initialPlan.current_status,
      })
      plans.push({
        order_id: orderId,
        title: typeof firstTitle === 'string' ? firstTitle : `Pedido ${orderId.slice(-8)}`,
        ...plan,
      })
    } catch (error) {
      console.error('[bulk-status-preview] order failed:', orderId, error)
      plans.push({
        order_id: orderId,
        title: null,
        current_status: null,
        proposed_status: newStatus,
        eligible: false,
        reason: 'No se pudo evaluar este pedido.',
      })
    }
  }

  return res.json({ plans })
}
