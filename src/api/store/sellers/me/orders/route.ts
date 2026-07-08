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

import { MedusaContainer } from '@medusajs/framework/types'
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { resolveSeller } from '../../../_utils/clerk-auth'
import { readRentalBooking, deriveRentalBookingState } from '../../../../../lib/rental-booking'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const sellerAuth = await resolveSeller(req)
  if (!sellerAuth) return res.status(401).json({ message: 'Unauthorized' })
  const { sellerId, sellerName } = sellerAuth

  const orders = await listOrdersForSeller(req.scope, sellerId, sellerName)
  return res.json({ orders, seller_id: sellerId })
}

/**
 * The shared order-listing query — extracted from the Clerk-gated `GET` above
 * (ml-orders-native S3 · US-9) so the new internal agent-read bridge
 * (`internal/sellers/orders/route.ts`) can call the SAME function instead of a
 * third copy of this query. Behavior-preserving; the Clerk route's `GET` is now
 * a thin wrapper.
 */
export async function listOrdersForSeller(
  scope: MedusaContainer,
  sellerId: string,
  sellerName: string,
): Promise<ReturnType<typeof normalizeMedusaOrder>[]> {
  const remoteQuery = (scope as any).resolve(ContainerRegistrationKeys.REMOTE_QUERY)

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
    return []
  }

  if (!productIds.length) return []

  // ── Fetch Medusa orders that contain these products ───────────────────────
  const knex = (scope as any).resolve(ContainerRegistrationKeys.PG_CONNECTION) as any

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

    if (!orderIds.length) return []

    // Step 2: fetch full order objects via the Remote Query (query.graph). Using
    // orderService.listOrders here throws "Shipping method version is required to
    // load adjustments" once an order has a shipping method — which silently
    // returned [] (the .catch) and made every seller's orders page look empty.
    const query = (scope as any).resolve(ContainerRegistrationKeys.QUERY)
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
  return (orders as any[]).map(o => normalizeMedusaOrder(o, sellerId, sellerName))
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

  // Raw per-item ids/qty/personalization (custom-print-products S4 · 4.3) —
  // unlike `personalization` above (filtered to items that HAVE fields), this
  // is EVERY item, so "Volver a pedir" can rebuild a configurator cart line
  // (variant selection alone, no custom fields, still needs a variant_id).
  const lineItems = ((order.items as any[]) ?? []).map((it: any) => ({
    product_id: (it?.product_id as string) ?? null,
    variant_id: (it?.variant_id as string) ?? null,
    quantity: Number(it?.quantity) || 1,
    unit_price_cents: Math.round(Number(it?.unit_price) || 0),
    personalization: (it?.metadata?.personalization ?? null) as unknown,
  }))

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

  // Refund-state machine (mirrors the frontend lib/refund-state.ts vocabulary so the
  // UCP/MCP order object an agent reads carries the same derived refund_state). The
  // off-platform SPEI/cash rail walks solicitado → aceptado → transferencia_pendiente →
  // confirmado (buyer confirms receipt); card/escrow refunds auto-confirm.
  const rr = (metadata.return_request ?? null) as Record<string, unknown> | null
  const refundState: string = (() => {
    if (!rr || !rr.status) return 'none'
    if (rr.status === 'requested') return 'solicitado'
    if (rr.status === 'declined') return 'rechazado'
    const refundStatus = (rr.refund_status as string | null) ?? null
    if (refundStatus === 'refunded' || refundStatus === 'voided') return 'confirmado'
    if (refundStatus === 'manual') {
      if (rr.buyer_confirmed_at) return 'confirmado'
      if (rr.transfer_sent_at || rr.refunded_at) return 'transferencia_pendiente'
      return 'aceptado'
    }
    return 'aceptado'
  })()

  // Pickup-appointment machine (Delivery & Manual-Money Polish S2 — mirrors the frontend
  // lib/pickup-appointment.ts vocabulary so the UCP/MCP order object an agent reads carries
  // the same derived state). The buyer proposes a date + window at checkout (propuesta), the
  // seller confirms (confirmada) or reschedules (back to propuesta, proposed_by seller).
  const pa = (metadata.pickup_appointment ?? null) as Record<string, unknown> | null
  const pickupAppointmentState: string = (() => {
    if (!pa || !pa.status) return 'none'
    if (pa.status === 'confirmada') return 'confirmada'
    if (pa.status === 'propuesta') return 'propuesta'
    return 'none'
  })()

  // Rental booking (rental line-item pricing S1.3): the derived state both sides +
  // agents read, plus the raw block so order pages / emails / the ledger render the
  // breakdown (noches × tarifa · depósito · total) without a second fetch. Absent for
  // every non-rental order → 'none' / null (frontend reads rental_booking_state ?? 'none').
  const rentalBooking = readRentalBooking(metadata)
  const rentalBookingState = deriveRentalBookingState(rentalBooking)

  const buyerName = customer
    ? [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null
    : null

  // Buyer's Clerk id (buyer-notifications-money-path S1.1) — stamped on the Medusa
  // customer at checkout (resolveOrCreateBuyerCustomer, start-checkout/route.ts) as
  // customer.metadata.clerk_user_id. null for guest orders (no customer link).
  const customerMetadata = (customer as unknown as { metadata?: Record<string, unknown> } | undefined)?.metadata
  const rawBuyerClerkUserId = customerMetadata?.clerk_user_id
  const buyerClerkUserId = typeof rawBuyerClerkUserId === 'string' && rawBuyerClerkUserId.length > 0
    ? rawBuyerClerkUserId
    : null

  // Which marketplace sold this (ml-orders-native S1 · US-3) — a DIFFERENT axis
  // from any buyer-traffic `channel` concept: this is "Mercado Libre vs Miyagi",
  // stamped by `materializeMlOrder` at order-creation time. `metadata` is already
  // selected above, so no query change is needed — just surface it top-level
  // (normalizeMedusaOrder curates; it never passes raw metadata through).
  const source = metadata.source === 'mercadolibre' ? 'mercadolibre' : 'miyagi'

  // Free-form seller tags (ml-orders-native S3 · US-7) — manual CRUD via
  // `[id]/tags`, plus the automatic 'mercadolibre' tag stamped at materialization.
  // No native Medusa order-tags concept exists (unlike Product), so this rides
  // metadata like every other cross-cutting order flag on this page.
  const tags = Array.isArray(metadata.tags)
    ? metadata.tags.filter((t): t is string => typeof t === 'string')
    : []

  return {
    id: order.id,
    status,
    source,
    tags,
    ml_order_id: source === 'mercadolibre' ? ((metadata.ml_order_id as string) ?? null) : null,
    ml_pack_id: source === 'mercadolibre' ? ((metadata.ml_pack_id as string) ?? null) : null,
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
    // Two-sided refund lifecycle (Delivery & Manual-Money Polish S1): the derived state
    // both sides + agents read, plus the raw record so the order pages can render detail
    // without a second fetch. refund_state ?? 'none' degrades gracefully pre-deploy.
    refund_state: refundState,
    return_request: rr,
    // Pickup appointment (S2): the derived state both sides + agents read, plus the raw
    // record so the order pages render the slot without a second fetch. Degrades to
    // 'none' / null pre-deploy (frontend reads pickup_appointment_state ?? 'none').
    pickup_appointment_state: pickupAppointmentState,
    pickup_appointment: pa,
    // Rental booking (S1.3): derived state + raw block so both order pages, both
    // emails, and the in-chat ledger render the dates + itemized deposit (Sprint 2
    // consumes these). Null / 'none' on every non-rental order — byte-for-byte
    // unchanged for today's orders.
    rental_booking_state: rentalBookingState,
    rental_booking: rentalBooking,
    event_tickets: Array.isArray(metadata.event_tickets) ? metadata.event_tickets : [],
    buyer_name: buyerName,
    buyer_email: (order.email as string) ?? customer?.email ?? null,
    buyer_clerk_user_id: buyerClerkUserId,
    // Per-line-item buyer personalization (empty array when none).
    personalization,
    // Raw per-item ids/qty/personalization for reorder (custom-print-products S4 · 4.3).
    line_items: lineItems,
    // Lightweight proof-of-print sign-off (custom-print-products S4 · 4.1):
    // a durable order-metadata flag pair, same curation discipline as
    // `tags`/`refund_state` above. Advisory only — never gates shipping.
    proof_sent: metadata.proof_sent === true,
    proof_sent_at: (metadata.proof_sent_at as string) ?? null,
    proof_image_url: (metadata.proof_image_url as string) ?? null,
    proof_size: (metadata.proof_size as string) ?? null,
    proof_quantity: typeof metadata.proof_quantity === 'number' ? metadata.proof_quantity : null,
    proof_price_cents: typeof metadata.proof_price_cents === 'number' ? metadata.proof_price_cents : null,
    proof_approved: metadata.proof_approved === true,
    proof_approved_at: (metadata.proof_approved_at as string) ?? null,
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
