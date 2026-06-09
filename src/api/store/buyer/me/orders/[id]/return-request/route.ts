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
 * PATCH /store/customers/me/orders/:id/return-request
 *   Body: { action: 'confirm_receipt' }
 *   The buyer confirms they received an off-platform (SPEI/cash) refund, closing the
 *   two-sided ladder: transferencia_pendiente → confirmado. Only the buyer can close it.
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

// ── PATCH — buyer confirms receipt of an off-platform refund ──────────────────

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params
  const { order, code } = await resolveOrderForBuyer(req, orderId)
  if (!order) return res.status(code).json({ message: code === 401 ? 'Unauthorized' : 'Order not found' })

  const body = (req.body ?? {}) as { action?: string }
  if (body.action !== 'confirm_receipt') {
    return res.status(422).json({ message: 'action must be "confirm_receipt"' })
  }

  const meta = (order.metadata ?? {}) as Record<string, unknown>
  const rr = (meta.return_request ?? null) as Record<string, unknown> | null
  if (!rr) return res.status(404).json({ message: 'No return request found for this order' })

  // Only the off-platform (SPEI/cash) ladder reaches the buyer-confirm step, and only
  // once the seller marked the transfer sent (transferencia_pendiente). Card/escrow
  // refunds auto-confirm seller-side and never wait on the buyer (the S1.1 guard:
  // aceptado → confirmado is rejected — the buyer can only close from transfer-sent).
  if (rr.refund_status !== 'manual' || !rr.transfer_sent_at) {
    return res.status(409).json({ message: 'No hay un reembolso por confirmar en este pedido.' })
  }
  if (rr.buyer_confirmed_at || rr.status === 'refunded') {
    return res.status(409).json({ message: 'El reembolso ya fue confirmado.' })
  }

  const now = new Date().toISOString()
  const orderService: any = req.scope.resolve(Modules.ORDER)
  const updated = { ...rr, status: 'refunded', buyer_confirmed_at: now, refunded_at: now }
  await orderService.updateOrders(orderId, { metadata: { ...meta, return_request: updated } })

  return res.json({ return_request: updated, refund_state: 'confirmado' })
}
