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
import { Modules } from '@medusajs/framework/utils'
import { normalizeMedusaOrder } from '../../../sellers/me/orders/route'
import { extractClerkUserId } from '../../../_utils/clerk-auth'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const customerService = req.scope.resolve(Modules.CUSTOMER) as any
  const orderService = req.scope.resolve(Modules.ORDER) as any

  // ── Find Medusa customer by external_id (Clerk user ID) ───────────────────
  let customers: any[] = []
  try {
    customers = await customerService.listCustomers(
      { external_id: clerkUserId },
      { select: ['id', 'email', 'first_name', 'last_name', 'external_id'] }
    )
  } catch (e) {
    console.error('[customers/me/orders] listCustomers error:', e)
  }

  const customer = customers[0] ?? null
  if (!customer) {
    // Customer not synced yet — return empty (will populate after next checkout)
    return res.json({ orders: [] })
  }

  // ── Fetch orders for this customer ────────────────────────────────────────
  let orders: unknown[] = []
  try {
    orders = await orderService.listOrders(
      { customer_id: customer.id },
      {
        select: [
          'id', 'status', 'payment_status', 'fulfillment_status',
          'total', 'subtotal', 'currency_code',
          'email', 'created_at', 'updated_at',
        ],
        relations: ['items', 'shipping_address', 'fulfillments'],
      }
    ).catch(() => [] as any[])
  } catch (e) {
    console.error('[customers/me/orders] listOrders error:', e)
  }

  // ── Normalize ─────────────────────────────────────────────────────────────
  // For buyer-facing orders we don't have a single seller — each order may have
  // items from different sellers. Use empty strings for seller fields; the
  // frontend enriches from Supabase marketplace_orders when needed.
  const normalized = (orders as any[]).map(o =>
    normalizeMedusaOrder(o, '', '')
  )

  return res.json({ orders: normalized, customer_id: customer.id })
}
