/**
 * GET /store/customers/me/orders
 *
 * Returns all Medusa orders for the authenticated buyer (identified by Clerk JWT).
 * Used to power the buyer's /account/orders page in the frontend.
 *
 * Auth: Clerk JWT in Authorization header.
 *
 * Response: { orders: NormalizedOrder[] }
 * (same NormalizedOrder shape as /store/sellers/me/orders — mirrors legacy Supabase shape)
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { normalizeMedusaOrder } from '../../../sellers/me/orders/route'
import { resolveBuyerCustomerIds } from '../../../_utils/clerk-auth'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  // Resolve ALL customer ids for this buyer (external_id + shared email) so an
  // order linked to the auth-flow customer OR the synced customer both show up.
  const { clerkUserId, customerIds } = await resolveBuyerCustomerIds(req)
  if (!clerkUserId) {
    return res.status(401).json({ message: 'Unauthorized' })
  }
  if (!customerIds.length) {
    return res.json({ orders: [] })
  }

  // ── Fetch orders for this buyer's customers ───────────────────────────────
  // Via query.graph — orderService.listOrders throws "Shipping method version is
  // required to load adjustments" once an order has a shipping method, which the
  // .catch silently turned into an empty list (buyer saw no orders).
  let orders: unknown[] = []
  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await (query as any).graph({
      entity: 'order',
      fields: [
        'id', 'status', 'payment_status', 'fulfillment_status',
        'total', 'subtotal', 'currency_code', 'email', 'metadata', 'created_at', 'updated_at',
        'items.*', 'shipping_address.*', 'fulfillments.*',
      ],
      filters: { customer_id: customerIds },
    })
    orders = data ?? []
  } catch (e) {
    console.error('[customers/me/orders] order query error:', e)
  }

  // ── Normalize ─────────────────────────────────────────────────────────────
  // For buyer-facing orders we don't have a single seller — each order may have
  // items from different sellers. Use empty strings for seller fields; the
  // frontend enriches from Supabase marketplace_orders when needed.
  const normalized = (orders as any[]).map(o =>
    normalizeMedusaOrder(o, '', '')
  )

  return res.json({ orders: normalized, customer_ids: customerIds })
}
