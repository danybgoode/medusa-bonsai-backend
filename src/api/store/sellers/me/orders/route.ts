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
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
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
  const knex = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as any

  let orders: unknown[] = []
  try {
    // Step 1: order IDs that contain the seller's products. Raw SQL via the join
    // table — order_line_item has no order_id column (it links through order_item),
    // and orderService.listLineItems does not exist on the Order service in this
    // Medusa version (it threw a TypeError → every seller's orders page was empty).
    const liRows = await knex.raw(
      `select distinct oi.order_id
         from order_item oi
         join order_line_item li on li.id = oi.item_id
        where li.product_id = ANY(?)`,
      [productIds],
    )
    const orderIds = ((liRows?.rows ?? []) as Array<{ order_id?: string }>)
      .map((r) => r.order_id)
      .filter(Boolean) as string[]

    if (!orderIds.length) {
      return res.json({ orders: [], seller_id: sellerId })
    }

    // Step 2: fetch full order objects via the Remote Query (query.graph). Using
    // orderService.listOrders here throws "Shipping method version is required to
    // load adjustments" once an order has a shipping method — which silently
    // returned [] (the .catch) and made every seller's orders page look empty.
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await (query as any).graph({
      entity: 'order',
      fields: [
        'id', 'status', 'payment_status', 'fulfillment_status',
        'total', 'subtotal', 'currency_code', 'email', 'metadata', 'created_at', 'updated_at',
        'items.*', 'shipping_address.*', 'customer.*', 'fulfillments.*',
      ],
      filters: { id: orderIds },
    })
    orders = data ?? []
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

  // Buyer personalization rides each line item's metadata (set at checkout). Surface
  // it per item so the seller (fulfillment) and the buyer can both see exactly what
  // was requested — Configurable & Personalized Products epic.
  const personalization = ((order.items as any[]) ?? [])
    .map((it: any) => {
      const p = it?.metadata?.personalization as { fields?: Array<{ id?: string; label?: string; value?: string }> } | undefined
      const fields = Array.isArray(p?.fields)
        ? p!.fields.filter(f => f && typeof f.value === 'string' && f.value.trim())
        : []
      return fields.length ? { title: (it?.title as string) ?? 'Producto', fields } : null
    })
    .filter(Boolean)
  const metadata = (order.metadata ?? {}) as Record<string, unknown>
  const checkoutSelection = (metadata.checkout_selection ?? {}) as Record<string, unknown>
  const support = (metadata.support ?? null) as Record<string, unknown> | null
  const isSupportOrder = support?.kind === 'support'
  const selectedFulfillment = (metadata.fulfillment_method ?? checkoutSelection.fulfillment_method ?? 'standard') as string

  // Manual payments (SPEI/cash/DiMo) are only *authorized* at checkout — the funds
  // aren't captured until the seller confirms receipt. Until then the order is
  // PENDING PAYMENT, not paid. (Card/MP orders are captured → 'paid'.)
  const paymentMethod = (metadata.payment_method as string) ?? null
  const isManualPay = ['manual', 'spei', 'cash', 'dimo'].includes(paymentMethod ?? '')
  const paymentStatus = (order.payment_status as string) ?? ''
  const isCaptured = paymentStatus === 'captured' || paymentStatus === 'partially_captured'
  const manualConfirmed = metadata.payment_received === true

  // Map to our status vocabulary. Refund/cancel wins; then manual-pending; then the
  // explicit lifecycle state we persist (seller PATCH), then Medusa fulfillment.
  let status = 'paid'
  if (
    order.status === 'canceled' ||
    (order.payment_status as string) === 'refunded' ||
    (order.fulfillment_status as string) === 'returned'
  ) {
    status = 'refunded'
  } else if (isManualPay && !isCaptured && !manualConfirmed) {
    status = 'pending_payment'
  } else if (typeof metadata.fulfillment_state === 'string') {
    status = metadata.fulfillment_state as string
  } else if ((order.fulfillment_status as string) === 'delivered') {
    status = 'delivered'
  } else if (['shipped', 'fulfilled'].includes(order.fulfillment_status as string)) {
    status = 'shipped'
  } else if ((order.fulfillment_status as string) === 'partially_fulfilled') {
    status = 'processing'
  }

  // Manual-payment state machine (mirrors the frontend lib/manual-payment-state.ts
  // vocabulary so the UCP/MCP order object an agent reads carries the same state).
  // pending_payment → buyer_reported_paid → payment_confirmed → processing.
  const buyerReportedPaid = metadata.buyer_reported_paid === true
  const paymentConfirmed = isCaptured || manualConfirmed
  const fulfillmentStarted = ['processing', 'shipped', 'in_transit', 'delivered', 'fulfilled', 'completed'].includes(status)
  const manualPaymentState = !isManualPay
    ? null
    : paymentConfirmed
      ? (fulfillmentStarted ? 'processing' : 'payment_confirmed')
      : buyerReportedPaid
        ? 'buyer_reported_paid'
        : 'pending_payment'

  const buyerName = customer
    ? [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null
    : null

  return {
    id: order.id,
    status,
    amount_cents: isSupportOrder ? (support.amount_cents ?? order.total ?? 0) : (order.total ?? 0),
    currency: ((order.currency_code as string) ?? 'mxn').toUpperCase(),
    shipping_method: isSupportOrder ? 'support' : selectedFulfillment,
    shipping_cost_cents: 0,
    // Direct-payment fields so the buyer order/success page can show instructions
    // and the pending-payment state.
    payment_method: (metadata.payment_method as string) ?? null,
    payment_received: metadata.payment_received === true,
    // Durable manual-payment lifecycle (Sprint 1): the buyer's "Ya hice el pago"
    // persists here and survives reload; manual_payment_state is the shared vocabulary.
    buyer_reported_paid: buyerReportedPaid,
    buyer_reported_paid_at: (metadata.buyer_reported_paid_at as string) ?? null,
    manual_payment_state: manualPaymentState,
    manual_payment: (metadata.manual_payment ?? null) as unknown,
    event_tickets: Array.isArray(metadata.event_tickets) ? metadata.event_tickets : [],
    buyer_name: buyerName,
    buyer_email: (order.email as string) ?? customer?.email ?? null,
    buyer_clerk_user_id: null,
    // Per-line-item buyer personalization (empty array when none).
    personalization,
    support: isSupportOrder ? support : null,
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
      title: isSupportOrder ? 'Apoyo / contribución' : ((item?.title as string) ?? 'Producto'),
      images: item?.thumbnail ? [{ url: item.thumbnail as string }] : null,
      listing_type: isSupportOrder ? 'support' : 'product',
      metadata: isSupportOrder ? support : null,
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
