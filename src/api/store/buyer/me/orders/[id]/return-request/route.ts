/**
 * Buyer-facing return request endpoints (Medusa-native).
 *
 * POST /store/customers/me/orders/:id/return-request
 *   Opens a return request on the Medusa order (metadata.return_request).
 *   Only allowed for delivered/completed orders, once per order.
 *   Returns the new return_request record.
 *
 * GET /store/customers/me/orders/:id/return-request
 *   Returns the current return_request state for this order.
 *
 * Auth: Clerk JWT — must match the order's customer.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { extractClerkUserId } from '../../../../../_utils/clerk-auth'

const VALID_REASONS = ['not_as_described', 'damaged', 'wrong_item', 'changed_mind', 'other'] as const

async function resolveOrderForBuyer(req: MedusaRequest, orderId: string) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return { order: null, customer: null, code: 401 as const }

  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const orderService: any = req.scope.resolve(Modules.ORDER)

  const [customer] = await customerService.listCustomers(
    { external_id: clerkUserId },
    { select: ['id', 'email'] }
  )
  if (!customer) return { order: null, customer: null, code: 404 as const }

  const [order] = await orderService.listOrders(
    { id: orderId, customer_id: customer.id },
    { select: ['id', 'status', 'total', 'currency_code', 'email', 'metadata'], relations: ['items'] }
  )
  if (!order) return { order: null, customer, code: 404 as const }
  return { order, customer, code: 200 as const }
}

// ── GET — return status ───────────────────────────────────────────────────────

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params
  const { order, code } = await resolveOrderForBuyer(req, orderId)
  if (!order) return res.status(code).json({ message: code === 401 ? 'Unauthorized' : 'Order not found' })

  const meta = (order.metadata ?? {}) as Record<string, unknown>
  return res.json({ return_request: meta.return_request ?? null })
}

// ── POST — open return request ────────────────────────────────────────────────

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params
  const { order, customer, code } = await resolveOrderForBuyer(req, orderId)
  if (!order || !customer) return res.status(code).json({ message: code === 401 ? 'Unauthorized' : 'Order not found' })

  const body = (req.body ?? {}) as { reason?: string; description?: string }

  if (!body.reason || !VALID_REASONS.includes(body.reason as typeof VALID_REASONS[number])) {
    return res.status(422).json({ message: 'Motivo de devolución inválido.' })
  }

  const meta = (order.metadata ?? {}) as Record<string, unknown>

  // Gate: only delivered/completed
  const fulfillmentState = meta.fulfillment_state as string | undefined
  const isDelivered = ['delivered', 'completed'].includes(fulfillmentState ?? '') || order.status === 'completed'
  if (!isDelivered) {
    return res.status(422).json({ message: 'Solo puedes solicitar una devolución después de recibir el pedido.' })
  }

  // Gate: one active return per order
  const existing = meta.return_request as Record<string, unknown> | undefined
  if (existing && existing.status !== 'declined') {
    return res.status(409).json({ message: 'Ya existe una solicitud de devolución.', return_request: existing })
  }

  const returnRequest = {
    status: 'requested',
    reason: body.reason,
    description: body.description?.trim() || null,
    buyer_email: customer.email ?? order.email ?? null,
    order_total_cents: order.total ?? 0,
    currency: order.currency_code ?? 'mxn',
    requested_at: new Date().toISOString(),
    seller_action: null,
    seller_action_at: null,
    refund_status: null,
    refund_amount_cents: null,
    refunded_at: null,
  }

  const orderService: any = req.scope.resolve(Modules.ORDER)
  await orderService.updateOrders(orderId, {
    metadata: { ...meta, return_request: returnRequest },
  })

  return res.status(201).json({ return_request: returnRequest })
}
