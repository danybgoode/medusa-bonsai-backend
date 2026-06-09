/**
 * Buyer-facing pickup-appointment endpoints (Delivery & Manual-Money Polish S2.2).
 *
 * GET /store/customers/me/orders/:id/pickup-appointment
 *   Returns the current pickup_appointment record.
 *
 * PATCH /store/customers/me/orders/:id/pickup-appointment
 *   Body: { action: 'confirm' }
 *   The buyer confirms a slot the seller proposed via reschedule (propuesta proposed_by
 *   'seller') → confirmada. The buyer's own initial proposal happens at checkout; this
 *   route only closes a seller counter (the symmetric half of S2.2).
 *
 * State rides order.metadata.pickup_appointment (Medusa-first, no new table). Pure write —
 * no money path. Auth: Clerk JWT — must match the order's customer.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { extractClerkUserId } from '../../../../../_utils/clerk-auth'

async function resolveOrderForBuyer(req: MedusaRequest, orderId: string) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return { order: null, code: 401 as const }

  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const orderService: any = req.scope.resolve(Modules.ORDER)

  const [customer] = await customerService.listCustomers(
    { external_id: clerkUserId },
    { select: ['id', 'email'] }
  )
  if (!customer) return { order: null, code: 404 as const }

  const [order] = await orderService.listOrders(
    { id: orderId, customer_id: customer.id },
    { select: ['id', 'status', 'metadata'], relations: ['items'] }
  )
  if (!order) return { order: null, code: 404 as const }
  return { order, code: 200 as const }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params
  const { order, code } = await resolveOrderForBuyer(req, orderId)
  if (!order) return res.status(code).json({ message: code === 401 ? 'Unauthorized' : 'Order not found' })

  const meta = (order.metadata ?? {}) as Record<string, unknown>
  return res.json({ pickup_appointment: meta.pickup_appointment ?? null })
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params
  const { order, code } = await resolveOrderForBuyer(req, orderId)
  if (!order) return res.status(code).json({ message: code === 401 ? 'Unauthorized' : 'Order not found' })

  const body = (req.body ?? {}) as { action?: string }
  if (body.action !== 'confirm') {
    return res.status(422).json({ message: 'action must be "confirm"' })
  }

  const meta = (order.metadata ?? {}) as Record<string, unknown>
  const pa = (meta.pickup_appointment ?? null) as Record<string, unknown> | null
  if (!pa || !pa.status) {
    return res.status(409).json({ message: 'Este pedido no tiene una cita de recolección propuesta.' })
  }
  // The buyer only confirms a seller counter. Their own proposal awaits the seller.
  if (pa.status !== 'propuesta' || pa.proposed_by !== 'seller') {
    return res.status(409).json({ message: 'No hay una propuesta del vendedor por confirmar.' })
  }

  const now = new Date().toISOString()
  const orderService: any = req.scope.resolve(Modules.ORDER)
  const updated = { ...pa, status: 'confirmada', confirmed_at: now }
  await orderService.updateOrders(orderId, { metadata: { ...meta, pickup_appointment: updated } })
  return res.json({ pickup_appointment: updated, pickup_appointment_state: 'confirmada' })
}
