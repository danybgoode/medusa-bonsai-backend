/**
 * POST /store/buyer/me/orders/:id/report-payment
 *
 * Buyer presses "Ya hice el pago" on a manual (SPEI/cash/DiMo) order. Durably
 * records `buyer_reported_paid` (+ timestamp) on the order metadata so the state
 * survives reload and both sides (and agents) read it — the seller's
 * "Confirmar pago recibido" remains the authoritative, capturing action.
 *
 * Mirrors the print `payment-reported` pattern (flag + timestamp on metadata) and
 * the seller `confirm-payment` write. Medusa-first: no Supabase, no new tables.
 *
 * Auth: Clerk JWT — must be the buyer who owns the order (customer_id or email).
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { resolveBuyerCustomerIds } from '../../../../../_utils/clerk-auth'

const MANUAL_METHODS = ['manual', 'spei', 'cash', 'dimo']

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { clerkUserId, customerIds, emails } = await resolveBuyerCustomerIds(req)
  if (!clerkUserId) return res.status(401).json({ message: 'Unauthorized' })
  if (!customerIds.length && !emails.length) return res.status(404).json({ message: 'Order not found' })

  const { id: orderId } = req.params

  // ── Fetch the order (query.graph — retrieveOrder throws once a shipping method exists) ──
  let order: Record<string, unknown>
  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await (query as any).graph({
      entity: 'order',
      fields: ['id', 'email', 'customer_id', 'payment_status', 'metadata'],
      filters: { id: orderId },
    })
    const result = (data ?? [])[0]
    if (!result) return res.status(404).json({ message: 'Order not found' })
    order = result as Record<string, unknown>
  } catch {
    return res.status(404).json({ message: 'Order not found' })
  }

  // ── Ownership: customer_id match, OR (manual orders with a null/mismatched
  //    customer_id) the order email matches one of the buyer's emails ──────────
  const ownsByCustomer = !!order.customer_id && customerIds.includes(order.customer_id as string)
  const ownsByEmail = !!order.email && emails.includes(String(order.email).toLowerCase())
  if (!ownsByCustomer && !ownsByEmail) {
    return res.status(404).json({ message: 'Order not found' })
  }

  const meta = (order.metadata ?? {}) as Record<string, unknown>
  const paymentMethod = (meta.payment_method as string) ?? ''
  if (!MANUAL_METHODS.includes(paymentMethod)) {
    return res.status(422).json({ message: 'Este pedido no es de pago manual (SPEI/efectivo/DiMo).' })
  }

  const paymentStatus = (order.payment_status as string) ?? ''
  const alreadyConfirmed = meta.payment_received === true ||
    paymentStatus === 'captured' || paymentStatus === 'partially_captured'
  if (alreadyConfirmed) {
    return res.status(409).json({ message: 'El pago de este pedido ya fue confirmado.' })
  }

  // Idempotent: re-reporting just returns the existing timestamp.
  if (meta.buyer_reported_paid === true) {
    return res.json({ reported: true, buyer_reported_paid_at: (meta.buyer_reported_paid_at as string) ?? null })
  }

  const now = new Date().toISOString()
  const orderService: any = req.scope.resolve(Modules.ORDER)
  await orderService.updateOrders(orderId, {
    metadata: { ...meta, buyer_reported_paid: true, buyer_reported_paid_at: now },
  })

  return res.json({ reported: true, buyer_reported_paid_at: now })
}
