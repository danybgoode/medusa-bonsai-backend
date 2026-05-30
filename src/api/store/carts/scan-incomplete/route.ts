/**
 * POST /store/carts/scan-incomplete
 *
 * Reconciliation safety net for the checkout flow. Finds carts that were paid
 * at the provider but never completed into a Medusa order (buyer abandoned the
 * redirect AND the frontend webhook missed), re-checks the provider as the
 * source of truth, patches the Medusa PaymentSession so authorizePayment will
 * pass, and returns the list of carts that are now ready to complete.
 *
 * The caller (Next.js cron /api/cron/reconcile-checkouts) then calls the
 * built-in POST /store/carts/:id/complete for each, and backfills the Supabase
 * order mirror.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 *
 * Body (all optional):
 *   older_than_minutes  number  default 10  — grace for webhook/redirect to land
 *   max_age_hours       number  default 24  — provider sessions expire ~24h
 *   limit               number  default 100 (max 300)
 */

import Stripe from 'stripe'
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { ICartModuleService, IPaymentModuleService } from '@medusajs/framework/types'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { resolveSellerMpToken } from '../../_utils/mp'

const STRIPE_PROVIDER_ID = 'pp_stripe-connect_stripe-connect'
const MP_PROVIDER_ID = 'pp_mercadopago_mercadopago'

type ReadyCart = {
  cart_id: string
  provider: 'stripe' | 'mercadopago'
  product_id: string
  seller_id: string
  amount_cents: number
  currency: string
  buyer_email: string | null
  buyer_name: string | null
  fulfillment_method: string | null
  pickup_spot_id: string | null
  shipping_amount_cents: number
  shipping_quote: {
    rate_id: string
    carrier: string | null
    service: string | null
    amount_cents: number
    currency: string
    delivery_estimate: number | null
    delivery_label: string | null
  } | null
  offer_id: string | null
  stripe_session_id: string | null
  mp_payment_id: string | null
}

function shippingQuoteFromCartMeta(meta: Record<string, any>) {
  if (!meta.shipping_rate_id) return null
  return {
    rate_id: String(meta.shipping_rate_id),
    carrier: meta.shipping_carrier ?? null,
    service: meta.shipping_service ?? null,
    amount_cents: Number(meta.shipping_amount_cents ?? 0) || 0,
    currency: meta.shipping_currency ?? 'MXN',
    delivery_estimate: meta.shipping_delivery_estimate != null ? Number(meta.shipping_delivery_estimate) : null,
    delivery_label: meta.shipping_delivery_label ?? null,
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  // ── Internal-secret auth ──────────────────────────────────────────────────
  const internalSecret = process.env.MEDUSA_INTERNAL_SECRET
  const headerSecret = req.headers['x-internal-secret'] as string | undefined
  if (internalSecret && headerSecret !== internalSecret) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const body = (req.body ?? {}) as { older_than_minutes?: number; max_age_hours?: number; limit?: number }
  const olderThanMs = Math.max(0, (body.older_than_minutes ?? 10)) * 60 * 1000
  const maxAgeMs = Math.max(1, (body.max_age_hours ?? 24)) * 60 * 60 * 1000
  const limit = Math.min(Math.max(1, body.limit ?? 100), 300)

  const cartService: ICartModuleService = req.scope.resolve(Modules.CART)
  const paymentService: IPaymentModuleService = req.scope.resolve(Modules.PAYMENT)
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const stripeKey = process.env.STRIPE_SECRET_KEY
  const stripeClient = stripeKey ? new Stripe(stripeKey, { apiVersion: '2025-09-30.clover' as any }) : null

  // ── Candidate carts: not completed, recent ────────────────────────────────
  const carts = await cartService.listCarts(
    { completed_at: null } as any,
    { take: limit, order: { created_at: 'DESC' }, relations: ['items'] } as any,
  )

  const now = Date.now()
  const ready: ReadyCart[] = []
  let scanned = 0
  let skippedUnpaid = 0
  const errors: string[] = []

  for (const cart of carts as any[]) {
    const createdMs = new Date(cart.created_at).getTime()
    const age = now - createdMs
    if (age < olderThanMs || age > maxAgeMs) continue

    const meta = (cart.metadata ?? {}) as Record<string, any>
    const provider = meta.payment_method as 'stripe' | 'mercadopago' | undefined
    if (!provider) continue
    // cart ↔ payment_collection is a module link, so the id must be read via the
    // query graph — it is NOT a column on the cart returned by listCarts.
    let collectionId: string | undefined
    try {
      const { data: [cg] } = await query.graph({
        entity: 'cart',
        fields: ['id', 'payment_collection.id'],
        filters: { id: cart.id },
      })
      collectionId = (cg as any)?.payment_collection?.id as string | undefined
    } catch { /* fall through — treated as no collection */ }
    if (!collectionId) continue

    scanned++

    const item = (cart.items ?? [])[0] as any
    const productId = item?.product_id ?? item?.variant?.product_id ?? ''
    const base = {
      cart_id: cart.id as string,
      product_id: meta.product_id ?? productId ?? '',
      seller_id: meta.seller_id ?? '',
      amount_cents: Math.round(Number(cart.total ?? 0)),
      currency: (cart.currency_code ?? 'mxn').toUpperCase(),
      buyer_email: cart.email ?? null,
      buyer_name: null as string | null,
      fulfillment_method: meta.fulfillment_method ?? null,
      pickup_spot_id: meta.pickup_spot_id ?? null,
      shipping_amount_cents: Number(meta.shipping_amount_cents ?? 0) || 0,
      shipping_quote: shippingQuoteFromCartMeta(meta),
      offer_id: meta.offer_id ?? null,
    }

    let sessions
    try {
      sessions = await paymentService.listPaymentSessions({ payment_collection_id: collectionId } as any)
    } catch (e) {
      errors.push(`sessions:${cart.id}`)
      continue
    }

    try {
      // ── Stripe ─────────────────────────────────────────────────────────────
      if (provider === 'stripe' && stripeClient) {
        const session = sessions.find((s: any) => s.provider_id === STRIPE_PROVIDER_ID)
        const data = (session?.data ?? {}) as Record<string, any>
        const stripeSessionId = data.stripe_session_id as string | undefined
        if (!session || !stripeSessionId) continue

        if (data.status !== 'paid') {
          const cs = await stripeClient.checkout.sessions.retrieve(stripeSessionId)
          if (cs.payment_status !== 'paid') { skippedUnpaid++; continue }
          await (paymentService as any).updatePaymentSession(session.id, {
            data: { ...data, status: 'paid', stripe_payment_intent: cs.payment_intent },
          })
        }
        ready.push({ ...base, provider: 'stripe', stripe_session_id: stripeSessionId, mp_payment_id: null })
      }

      // ── MercadoPago (per-seller marketplace token) ───────────────────────────
      else if (provider === 'mercadopago') {
        const sellerId = (meta.seller_id as string | undefined) ?? base.seller_id
        if (!sellerId) continue
        const [seller] = await sellerService.listSellers({ id: sellerId } as any, { take: 1 })
        const mpToken = seller ? await resolveSellerMpToken(sellerService, seller) : null
        if (!mpToken) continue

        const session = sessions.find((s: any) => s.provider_id === MP_PROVIDER_ID)
        const data = (session?.data ?? {}) as Record<string, any>
        if (!session) continue

        let mpPaymentId = data.mp_payment_id as string | undefined
        let payerName: string | null = null

        if (data.status !== 'approved' || !mpPaymentId) {
          const prefId = data.mp_preference_id as string | undefined
          if (!prefId) continue
          // Find the approved payment for this preference via merchant orders.
          const moRes = await fetch(
            `https://api.mercadopago.com/merchant_orders/search?preference_id=${encodeURIComponent(prefId)}`,
            { headers: { Authorization: `Bearer ${mpToken}` } },
          )
          const mo = await moRes.json().catch(() => null) as { elements?: Array<{ payments?: Array<{ id: number | string; status: string }> }> } | null
          const approved = (mo?.elements ?? [])
            .flatMap(e => e.payments ?? [])
            .find(p => p.status === 'approved')
          if (!approved) { skippedUnpaid++; continue }
          mpPaymentId = String(approved.id)
          await (paymentService as any).updatePaymentSession(session.id, {
            data: { ...data, mp_payment_id: mpPaymentId, status: 'approved' },
          })
        }

        // Enrich amount/buyer from the payment when available (cart.total can be 0 for offers).
        try {
          const payRes = await fetch(`https://api.mercadopago.com/v1/payments/${mpPaymentId}`, {
            headers: { Authorization: `Bearer ${mpToken}` },
          })
          const pay = await payRes.json().catch(() => null) as any
          if (pay) {
            if (pay.transaction_amount) base.amount_cents = Math.round(pay.transaction_amount * 100)
            if (pay.payer?.email) base.buyer_email = pay.payer.email
            payerName = [pay.payer?.first_name, pay.payer?.last_name].filter(Boolean).join(' ').trim() || null
            if (pay.metadata?.seller_id && !base.seller_id) base.seller_id = String(pay.metadata.seller_id)
          }
        } catch { /* non-fatal — fall back to cart values */ }

        ready.push({ ...base, buyer_name: payerName, provider: 'mercadopago', stripe_session_id: null, mp_payment_id: mpPaymentId ?? null })
      }
    } catch (e) {
      console.error('[scan-incomplete] provider check failed for cart', cart.id, e)
      errors.push(`provider:${cart.id}`)
    }
  }

  return res.json({ ready, scanned, ready_count: ready.length, skipped_unpaid: skippedUnpaid, errors })
}
