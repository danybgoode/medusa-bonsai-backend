/**
 * Seller-facing pickup-appointment management (Delivery & Manual-Money Polish S2.2).
 *
 * GET /store/sellers/me/orders/:id/pickup-appointment
 *   Returns the current pickup_appointment record.
 *
 * PATCH /store/sellers/me/orders/:id/pickup-appointment
 *   Body: { action: 'confirm' | 'reschedule', date?: string, window?: string }
 *
 *   confirm    → the buyer proposed a slot; the seller agrees. propuesta → confirmada.
 *   reschedule → the seller counters with a new date + window. The appointment re-enters
 *                propuesta (proposed_by 'seller'), awaiting the buyer's confirm (the buyer
 *                route closes it). Allowed from either propuesta or confirmada.
 *
 * State rides order.metadata.pickup_appointment (Medusa-first, no new table); the
 * normalizer derives pickup_appointment_state for both sides + agents. Pure write — no
 * money path. Auth: Clerk JWT — must be the seller of a product in the order.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { resolveSeller } from '../../../../../_utils/clerk-auth'
import { resolveSellerProductIds } from '../../../../../_utils/seller-catalog-query'

const WINDOWS = new Set(['manana', 'tarde', 'noche'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

async function resolveOrderForSeller(req: MedusaRequest, orderId: string) {
  const sellerAuth = await resolveSeller(req)
  if (!sellerAuth) return { order: null, sellerId: null, code: 401 as const }

  const orderService: any = req.scope.resolve(Modules.ORDER)
  const [order] = await orderService.listOrders(
    { id: orderId },
    { select: ['id', 'status', 'metadata'], relations: ['items'] }
  )
  if (!order) return { order: null, sellerId: null, code: 404 as const }

  const productIds = ((order.items ?? []) as any[]).map((i: any) => i.product_id).filter(Boolean)
  if (productIds.length) {
    const sellerProductIds = await resolveSellerProductIds(
      req.scope,
      sellerAuth.sellerId,
      { includeDeleted: true },
    )
    const owns = productIds.some((pid: string) => sellerProductIds.has(pid))
    if (!owns) return { order: null, sellerId: null, code: 403 as const }
  }

  return { order, sellerId: sellerAuth.sellerId, code: 200 as const }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params
  const { order, code } = await resolveOrderForSeller(req, orderId)
  if (!order) return res.status(code).json({ message: code === 401 ? 'Unauthorized' : code === 403 ? 'Forbidden' : 'Order not found' })

  const meta = (order.metadata ?? {}) as Record<string, unknown>
  return res.json({ pickup_appointment: meta.pickup_appointment ?? null })
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params
  const { order, code } = await resolveOrderForSeller(req, orderId)
  if (!order) return res.status(code).json({ message: code === 401 ? 'Unauthorized' : code === 403 ? 'Forbidden' : 'Order not found' })

  const body = (req.body ?? {}) as { action?: string; date?: string; window?: string }
  if (!['confirm', 'reschedule'].includes(body.action ?? '')) {
    return res.status(422).json({ message: 'action must be "confirm" or "reschedule"' })
  }

  const meta = (order.metadata ?? {}) as Record<string, unknown>
  const pa = (meta.pickup_appointment ?? null) as Record<string, unknown> | null
  if (!pa || !pa.status) {
    return res.status(409).json({ message: 'Este pedido no tiene una cita de recolección propuesta.' })
  }

  const orderService: any = req.scope.resolve(Modules.ORDER)
  const now = new Date().toISOString()

  if (body.action === 'confirm') {
    // Only the side that did NOT propose can confirm. The seller confirms a buyer's
    // proposal; if the seller already countered (proposed_by 'seller') it's the buyer's turn.
    if (pa.status !== 'propuesta' || pa.proposed_by !== 'buyer') {
      return res.status(409).json({ message: 'No hay una propuesta del comprador por confirmar.' })
    }
    const updated = { ...pa, status: 'confirmada', confirmed_at: now }
    await orderService.updateOrders(orderId, { metadata: { ...meta, pickup_appointment: updated } })
    return res.json({ pickup_appointment: updated, pickup_appointment_state: 'confirmada' })
  }

  // reschedule — the seller counters with a new window; re-enters propuesta (by seller).
  if (!body.date || !DATE_RE.test(body.date)) {
    return res.status(422).json({ message: 'date inválida (formato YYYY-MM-DD).' })
  }
  if (!body.window || !WINDOWS.has(body.window)) {
    return res.status(422).json({ message: 'window inválida.' })
  }
  const updated = {
    ...pa,
    date: body.date,
    window: body.window,
    status: 'propuesta',
    proposed_by: 'seller',
    proposed_at: now,
    confirmed_at: null,
  }
  await orderService.updateOrders(orderId, { metadata: { ...meta, pickup_appointment: updated } })
  return res.json({ pickup_appointment: updated, pickup_appointment_state: 'propuesta' })
}
