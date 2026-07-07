/**
 * POST /store/buyer/me/orders/:id/proof-approve
 *
 * Buyer approves the seller's proof (custom-print-products epic, Sprint 4 ·
 * Story 4.1). Durably records `proof_approved` (+ timestamp) on the order
 * metadata so the state survives reload and both sides (and agents) read it.
 * Advisory only — this never gates shipping in v1, mirrors the buyer
 * `report-payment` pattern (flag + timestamp on metadata, no new table).
 *
 * Auth: Clerk JWT — must be the buyer who owns the order (customer_id or email).
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { resolveBuyerCustomerIds } from '../../../../../_utils/clerk-auth'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { clerkUserId, customerIds, emails } = await resolveBuyerCustomerIds(req)
  if (!clerkUserId) return res.status(401).json({ message: 'Unauthorized' })
  if (!customerIds.length && !emails.length) return res.status(404).json({ message: 'Order not found' })

  const { id: orderId } = req.params

  let order: Record<string, unknown>
  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await (query as any).graph({
      entity: 'order',
      fields: ['id', 'email', 'customer_id', 'metadata'],
      filters: { id: orderId },
    })
    const result = (data ?? [])[0]
    if (!result) return res.status(404).json({ message: 'Order not found' })
    order = result as Record<string, unknown>
  } catch {
    return res.status(404).json({ message: 'Order not found' })
  }

  const ownsByCustomer = !!order.customer_id && customerIds.includes(order.customer_id as string)
  const ownsByEmail = !!order.email && emails.includes(String(order.email).toLowerCase())
  if (!ownsByCustomer && !ownsByEmail) {
    return res.status(404).json({ message: 'Order not found' })
  }

  const meta = (order.metadata ?? {}) as Record<string, unknown>
  if (!meta.proof_sent) {
    return res.status(422).json({ message: 'No hay una prueba pendiente para este pedido.' })
  }

  // Idempotent: re-approving just returns the existing timestamp.
  if (meta.proof_approved === true) {
    return res.json({ approved: true, proof_approved_at: (meta.proof_approved_at as string) ?? null })
  }

  const now = new Date().toISOString()
  const orderService: any = req.scope.resolve(Modules.ORDER)
  await orderService.updateOrders(orderId, {
    metadata: { ...meta, proof_approved: true, proof_approved_at: now },
  })

  return res.json({ approved: true, proof_approved_at: now })
}
