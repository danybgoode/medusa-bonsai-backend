/**
 * GET /internal/diagnose-orders  (READ-ONLY)
 *
 * Dumps recent orders with the fields that decide whether buyer + seller order
 * pages can see them: customer_id/email (buyer detail ownership), line-item
 * product_id (seller lookup), payment/fulfillment status, shipping methods, and
 * the product→seller link for the first item. Diagnoses empty order pages +
 * "ver mi pedido" 404 for manual checkouts.
 *
 * Auth: x-internal-secret header. No writes.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'

function authed(req: MedusaRequest): boolean {
  const secret = process.env.MEDUSA_INTERNAL_SECRET
  const provided = req.headers['x-internal-secret'] as string | undefined
  return !secret || provided === secret
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!authed(req)) return res.status(401).json({ message: 'Unauthorized' })

  const orderService: any = req.scope.resolve(Modules.ORDER)
  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const query: any = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const out: Record<string, unknown> = {}

  // Recent orders. NOTE: loading the shipping_methods relation here throws
  // "Shipping method version is required to load adjustments", so we read it
  // separately via query.graph below.
  let orders: any[] = []
  try {
    orders = await orderService.listOrders(
      {},
      {
        select: ['id', 'status', 'payment_status', 'fulfillment_status', 'email', 'customer_id', 'metadata', 'total', 'created_at'],
        relations: ['items'],
        order: { created_at: 'DESC' },
        take: 8,
      },
    )
  } catch (e) {
    out.orders_error = String(e)
  }

  // Shipping methods via the graph (avoids the version error above).
  let smByOrder: Record<string, any[]> = {}
  try {
    const ids = (orders ?? []).map((o: any) => o.id)
    if (ids.length) {
      const { data } = await query.graph({
        entity: 'order',
        fields: ['id', 'shipping_methods.name', 'shipping_methods.amount', 'shipping_methods.shipping_option_id'],
        filters: { id: ids },
      })
      smByOrder = Object.fromEntries((data ?? []).map((o: any) => [o.id, o.shipping_methods ?? []]))
    }
  } catch (e) {
    out.shipping_methods_error = String(e)
  }

  out.orders = (orders ?? []).map((o: any) => ({
    id: o.id,
    created_at: o.created_at,
    email: o.email,
    customer_id: o.customer_id ?? null,
    status: o.status,
    payment_status: o.payment_status,
    fulfillment_status: o.fulfillment_status,
    payment_method: (o.metadata ?? {}).payment_method ?? null,
    fulfillment_method: (o.metadata ?? {}).fulfillment_method ?? null,
    shipping_rate_id: (o.metadata ?? {}).shipping_rate_id ?? null,
    item_count: (o.items ?? []).length,
    item_product_ids: (o.items ?? []).map((i: any) => i.product_id ?? null),
    shipping_methods: (smByOrder[o.id] ?? []).map((s: any) => ({ name: s.name, amount: s.amount, shipping_option_id: s.shipping_option_id })),
  }))

  // For the most recent order: resolve customer (by id) + product→seller link
  const recent = (orders ?? [])[0]
  if (recent) {
    if (recent.customer_id) {
      try {
        const c = await customerService.retrieveCustomer(recent.customer_id, { select: ['id', 'email', 'external_id'] })
        out.recent_customer = { id: c.id, email: c.email, external_id: c.external_id }
      } catch (e) { out.recent_customer_error = String(e) }
    } else {
      out.recent_customer = 'ORDER HAS NO customer_id'
    }
    const pid = (recent.items ?? [])[0]?.product_id
    if (pid) {
      try {
        const { data } = await query.graph({
          entity: 'product',
          fields: ['id', 'seller.id', 'seller.name'],
          filters: { id: pid },
        })
        out.recent_product_seller = (data?.[0] as any)?.seller ?? 'NO seller link'
      } catch (e) { out.recent_product_seller_error = String(e) }
    }
  }

  return res.json(out)
}
