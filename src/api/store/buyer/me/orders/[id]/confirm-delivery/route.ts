/**
 * POST /store/customers/me/orders/:id/confirm-delivery
 *
 * Buyer confirms receipt of the item. For escrow orders this triggers the
 * Stripe PaymentIntent capture, releasing funds to the seller.
 * For non-escrow orders it marks delivery as buyer-confirmed in metadata.
 *
 * Auth: Clerk JWT — must be the buyer (customer linked to order).
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { capturePaymentWorkflow } from '@medusajs/medusa/core-flows'
import { extractClerkUserId } from '../../../../../_utils/clerk-auth'
import { logger } from '../../../../../../../lib/logger'

async function resolveOrderForBuyer(req: MedusaRequest, orderId: string) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return { order: null, code: 401 as const }

  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const orderService: any = req.scope.resolve(Modules.ORDER)

  const [customer] = await customerService.listCustomers(
    { external_id: clerkUserId },
    { select: ['id', 'email'] }
  )
  if (!customer) return { order: null, code: 401 as const }

  const [order] = await orderService.listOrders(
    { id: orderId, customer_id: customer.id },
    { select: ['id', 'status', 'payment_status', 'metadata'], relations: ['items'] }
  )
  if (!order) return { order: null, code: 404 as const }

  return { order, code: 200 as const }
}

async function getOrderPaymentId(req: MedusaRequest, orderId: string): Promise<string | null> {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await (query as any).graph({
    entity: 'order',
    fields: ['id', 'payment_collections.payments.id'],
    filters: { id: orderId },
  })
  return (data?.[0] as any)?.payment_collections?.[0]?.payments?.[0]?.id ?? null
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params
  const { order, code } = await resolveOrderForBuyer(req, orderId)
  if (!order) {
    return res.status(code).json({ message: code === 401 ? 'Unauthorized' : 'Order not found' })
  }

  const meta = (order.metadata ?? {}) as Record<string, unknown>

  if (meta.delivery_confirmed_at) {
    return res.status(409).json({ message: 'La recepción ya fue confirmada.' })
  }

  const now = new Date().toISOString()
  const orderService: any = req.scope.resolve(Modules.ORDER)

  // For escrow orders: trigger payment capture to release funds to seller
  if (meta.escrow_mode && !meta.escrow_captured) {
    const paymentId = await getOrderPaymentId(req, orderId)
    if (paymentId) {
      try {
        await capturePaymentWorkflow(req.scope).run({
          input: { payment_id: paymentId },
        })
      } catch (e) {
        const msg = (e as Error).message ?? 'Capture failed'
        logger.error('confirm-delivery', 'escrow capture failed', { orderId, message: msg })
        return res.status(502).json({ message: `No se pudo liberar el pago al vendedor: ${msg}` })
      }
    }
  }

  await orderService.updateOrders(orderId, {
    metadata: {
      ...meta,
      delivery_confirmed_at: now,
      delivery_confirmed_by: 'buyer',
      ...(meta.escrow_mode ? { escrow_captured: true, escrow_captured_at: now } : {}),
    },
  })

  return res.json({
    confirmed: true,
    delivery_confirmed_at: now,
    escrow_captured: !!meta.escrow_mode,
  })
}
