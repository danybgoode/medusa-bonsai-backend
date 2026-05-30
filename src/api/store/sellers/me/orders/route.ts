/**
 * GET /store/sellers/me/orders
 *
 * Returns all Medusa orders that contain products belonging to the
 * authenticated seller.  Requires Clerk JWT in the Authorization header.
 *
 * Response: { orders: NormalizedOrder[] }
 *
 * NormalizedOrder shape mirrors the legacy Supabase marketplace_orders shape
 * so the existing frontend UI components work without changes.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { resolveSeller } from '../../../_utils/clerk-auth'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const sellerAuth = await resolveSeller(req)
  if (!sellerAuth) return res.status(401).json({ message: 'Unauthorized' })
  const { sellerId, sellerName } = sellerAuth

  const remoteQuery = req.scope.resolve(ContainerRegistrationKeys.REMOTE_QUERY)

  // ── Get seller's product IDs ──────────────────────────────────────────────
  let productIds: string[] = []
  try {
    const { data: sellerRows } = await (remoteQuery as any).graph({
      entity: 'seller',
      fields: ['id', 'products.id'],
      filters: { id: sellerId },
    })
    productIds = ((sellerRows?.[0] as any)?.products ?? []).map((p: any) => p.id as string)
  } catch {
    return res.json({ orders: [], seller_id: sellerId })
  }

  if (!productIds.length) {
    return res.json({ orders: [], seller_id: sellerId })
  }

  // ── Fetch Medusa orders that contain these products ───────────────────────
  const orderService = req.scope.resolve(Modules.ORDER) as any

  let orders: unknown[] = []
  try {
    // Step 1: find line items for seller's products → get order IDs
    const lineItems: Array<{ order_id?: string; order?: { id: string } }> =
      await orderService.listLineItems(
        { product_id: productIds },
        { select: ['id', 'order_id', 'product_id', 'title', 'thumbnail', 'unit_price', 'quantity'] }
      ).catch(() => [] as any[])

    const orderIds = [...new Set(
      lineItems.map(li => li.order_id ?? (li.order as any)?.id).filter(Boolean)
    )] as string[]

    if (!orderIds.length) {
      return res.json({ orders: [], seller_id: sellerId })
    }

    // Step 2: fetch full order objects
    orders = await orderService.listOrders(
      { id: orderIds },
      {
        select: [
          'id', 'status', 'payment_status', 'fulfillment_status',
          'total', 'subtotal', 'currency_code',
          'email', 'metadata', 'created_at', 'updated_at',
        ],
        relations: ['items', 'shipping_address', 'customer', 'fulfillments'],
      }
    ).catch(() => [] as any[])
  } catch (e) {
    console.error('[seller/me/orders] order query error:', e)
  }

  // ── Normalize to legacy shape ─────────────────────────────────────────────
  const normalized = (orders as any[]).map(o => normalizeMedusaOrder(o, sellerId, sellerName))

  return res.json({ orders: normalized, seller_id: sellerId })
}

// ── Normalization helper ──────────────────────────────────────────────────────

export function normalizeMedusaOrder(
  order: Record<string, unknown>,
  sellerId: string,
  sellerName: string,
) {
  const item = (order.items as any[])?.[0]
  const sa = order.shipping_address as Record<string, string> | undefined
  const customer = order.customer as Record<string, string> | undefined
  const metadata = (order.metadata ?? {}) as Record<string, unknown>
  const checkoutSelection = (metadata.checkout_selection ?? {}) as Record<string, unknown>
  const selectedFulfillment = (metadata.fulfillment_method ?? checkoutSelection.fulfillment_method ?? 'standard') as string

  // Map to our status vocabulary. Refund/cancel always wins; otherwise prefer the
  // explicit lifecycle state we persist on the order (set by the seller PATCH
  // route), falling back to Medusa's native fulfillment_status for legacy orders.
  let status = 'paid'
  if (
    order.status === 'canceled' ||
    (order.payment_status as string) === 'refunded' ||
    (order.fulfillment_status as string) === 'returned'
  ) {
    status = 'refunded'
  } else if (typeof metadata.fulfillment_state === 'string') {
    status = metadata.fulfillment_state as string
  } else if ((order.fulfillment_status as string) === 'delivered') {
    status = 'delivered'
  } else if (['shipped', 'fulfilled'].includes(order.fulfillment_status as string)) {
    status = 'shipped'
  } else if ((order.fulfillment_status as string) === 'partially_fulfilled') {
    status = 'processing'
  }

  const buyerName = customer
    ? [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null
    : null

  return {
    id: order.id,
    status,
    amount_cents: order.total ?? 0,
    currency: ((order.currency_code as string) ?? 'mxn').toUpperCase(),
    shipping_method: selectedFulfillment,
    shipping_cost_cents: 0,
    buyer_name: buyerName,
    buyer_email: (order.email as string) ?? customer?.email ?? null,
    buyer_clerk_user_id: null,
    created_at: order.created_at,
    updated_at: order.updated_at,
    shipping_address: sa ? {
      name: [sa.first_name, sa.last_name].filter(Boolean).join(' '),
      line1: sa.address_1 ?? '',
      line2: sa.address_2 ?? '',
      city: sa.city ?? '',
      state: sa.province ?? '',
      postal_code: sa.postal_code ?? '',
      country: sa.country_code ?? 'MX',
    } : null,
    // Nested shapes that the UI expects
    marketplace_listings: {
      id: (item?.product_id as string) ?? (order.id as string),
      title: (item?.title as string) ?? 'Producto',
      images: item?.thumbnail ? [{ url: item.thumbnail as string }] : null,
      listing_type: 'product',
      metadata: null,
    },
    marketplace_shops: {
      id: sellerId,
      name: sellerName,
      slug: '',
      clerk_user_id: null,
      metadata: null,
    },
    marketplace_shipments: (() => {
      // Prefer the shipment we persist on the order (set by the seller PATCH route).
      const sh = (metadata.shipment ?? null) as Record<string, any> | null
      if (sh && (sh.tracking_number || sh.carrier || sh.status)) {
        return [{
          id: `${order.id}_ship`,
          carrier: sh.carrier ?? 'manual',
          tracking_number: sh.tracking_number ?? null,
          label_url: sh.label_url ?? null,
          status: sh.status ?? 'label_created',
          estimated_delivery_date: sh.estimated_delivery_date ?? null,
          weight_grams: null,
          envia_shipment_id: null,
          created_at: sh.created_at ?? order.created_at,
        }]
      }
      // Fallback: native Medusa fulfillments (legacy / future full-fulfillment).
      return ((order.fulfillments as any[]) ?? []).length > 0
        ? ((order.fulfillments as any[]).map((f: any) => ({
            id: f.id,
            carrier: f.data?.carrier ?? 'manual',
            tracking_number: f.labels?.[0]?.tracking_number ?? f.tracking_numbers?.[0]?.tracking_number ?? null,
            label_url: f.labels?.[0]?.label_url ?? f.data?.label_url ?? null,
            status: f.delivered_at ? 'delivered' : f.shipped_at ? 'shipped' : 'label_created',
            estimated_delivery_date: null,
            weight_grams: null,
            envia_shipment_id: null,
            created_at: f.created_at,
          })))
        : null
    })(),
    // Mark as Medusa-backed for routing decisions in the frontend
    _source: 'medusa',
    _medusa_order_id: order.id,
  }
}
