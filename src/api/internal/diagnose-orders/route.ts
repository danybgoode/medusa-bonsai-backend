/**
 * GET /internal/diagnose-orders  (READ-ONLY)
 *
 * Dumps recent orders via query.graph (the Remote Query handles order versioning,
 * unlike orderService.listOrders which throws "Shipping method version is required
 * to load adjustments" once an order has shipping methods). Shows the fields that
 * decide buyer + seller order visibility.
 *
 * Auth: x-internal-secret header. No writes.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'

function authed(req: MedusaRequest): boolean {
  const secret = process.env.MEDUSA_INTERNAL_SECRET
  const provided = req.headers['x-internal-secret'] as string | undefined
  return !secret || provided === secret
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!authed(req)) return res.status(401).json({ message: 'Unauthorized' })

  const query: any = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const out: Record<string, unknown> = {}

  let orders: any[] = []
  try {
    const { data } = await query.graph({
      entity: 'order',
      fields: [
        'id', 'status', 'payment_status', 'fulfillment_status', 'email', 'customer_id',
        'metadata', 'created_at',
        'items.product_id', 'items.title',
        'shipping_methods.name', 'shipping_methods.amount', 'shipping_methods.shipping_option_id',
        'customer.id', 'customer.external_id', 'customer.email',
      ],
      pagination: { take: 8, order: { created_at: 'DESC' } },
    })
    orders = data ?? []
  } catch (e) {
    out.orders_error = String(e)
  }

  out.order_count = orders.length
  out.orders = orders.map((o: any) => ({
    id: o.id,
    created_at: o.created_at,
    email: o.email,
    customer_id: o.customer_id ?? null,
    customer_external_id: o.customer?.external_id ?? null,
    status: o.status,
    payment_status: o.payment_status,
    fulfillment_status: o.fulfillment_status,
    payment_method: (o.metadata ?? {}).payment_method ?? null,
    fulfillment_method: (o.metadata ?? {}).fulfillment_method ?? null,
    shipping_rate_id: (o.metadata ?? {}).shipping_rate_id ?? null,
    item_product_ids: (o.items ?? []).map((i: any) => i.product_id ?? null),
    shipping_methods: (o.shipping_methods ?? []).map((s: any) => ({ name: s.name, amount: s.amount, option: s.shipping_option_id })),
  }))

  // For the most recent order: product → seller link
  const pid = (orders?.[0]?.items ?? [])[0]?.product_id
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

  return res.json(out)
}
