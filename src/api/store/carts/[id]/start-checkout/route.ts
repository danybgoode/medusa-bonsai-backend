/**
 * POST /store/carts/:id/start-checkout
 *
 * Orchestrates the checkout handoff to Stripe Connect or MercadoPago.
 *
 * 1. Loads the cart and its line items
 * 2. Finds the product's linked seller + seller payment config
 * 3. Creates the external checkout session (Stripe / MP Preference)
 * 4. Creates a Medusa PaymentSession with the external data attached
 * 5. Returns { redirect_url, cart_id, payment_session_id }
 *
 * The frontend redirects the user to redirect_url. On return, the success
 * page calls POST /store/carts/:id/complete which runs authorizePayment.
 */

import Stripe from 'stripe'
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { ICartModuleService, IPaymentModuleService, IRegionModuleService } from '@medusajs/framework/types'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id: cartId } = req.params
  const body = req.body as {
    provider: 'stripe' | 'mercadopago'
    buyer_email?: string
    offer_amount_cents?: number   // accepted offer override
    offer_id?: string             // Supabase offer ID for webhook reconciliation
    seller_id?: string            // skip expensive seller scan when caller already knows it
  }

  if (!body.provider) {
    return res.status(400).json({ message: 'provider is required: "stripe" or "mercadopago"' })
  }

  const cartService: ICartModuleService = req.scope.resolve(Modules.CART)
  const paymentService: IPaymentModuleService = req.scope.resolve(Modules.PAYMENT)
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const remoteQuery = req.scope.resolve(ContainerRegistrationKeys.REMOTE_QUERY)

  // ── Load cart ─────────────────────────────────────────────────────────────
  const [cart] = await cartService.listCarts(
    { id: cartId },
    { relations: ['items', 'items.variant', 'region'] }
  )

  if (!cart) {
    return res.status(404).json({ message: 'Cart not found' })
  }
  if (!cart.items?.length) {
    return res.status(400).json({ message: 'Cart is empty' })
  }

  const item = cart.items[0] as any
  const productId = item.product_id ?? item.variant?.product_id

  // For multi-item carts, build a combined title (used in payment provider display)
  const allTitles = cart.items.map((i: any) => (i as any).title ?? 'Producto').filter(Boolean)
  const productTitle = allTitles.length > 1
    ? `${allTitles[0]} + ${allTitles.length - 1} más`
    : (allTitles[0] ?? 'Producto')
  const productImage = (item as any).thumbnail ?? null

  // ── Find seller for this product ──────────────────────────────────────────
  let seller: any = null
  if (body.seller_id) {
    // Fast path — caller already knows the seller
    const [found] = await sellerService.listSellers({ id: body.seller_id } as any, { take: 1 })
    seller = found ?? null
  } else if (productId) {
    // Slow path — scan all sellers to find which one owns this product
    const allSellers = await sellerService.listSellers({}, { take: 500 })
    for (const s of allSellers) {
      try {
        const { data: rows } = await (remoteQuery as any)({
          seller: {
            fields: ['id', 'products.id'],
            variables: { filters: { id: s.id } },
          },
        })
        const ids = ((rows?.[0] as any)?.products ?? []).map((p: any) => p.id)
        if (ids.includes(productId)) {
          seller = s
          break
        }
      } catch {
        // no products linked
      }
    }
  }

  const currency = (cart.currency_code ?? 'mxn').toLowerCase()
  const priceCents = body.offer_amount_cents ?? Math.round(Number(cart.total ?? 0))

  if (!seller) {
    return res.status(422).json({
      message: 'Este anuncio aún no tiene vendedor registrado.',
      code: 'SELLER_NOT_CONNECTED',
    })
  }

  const sellerMeta = (seller.metadata ?? {}) as Record<string, unknown>
  const sellerSettings = (sellerMeta.settings ?? {}) as Record<string, unknown>

  const successUrl = `${SITE_URL}/payment/success?cart_id=${cartId}`
  const cancelUrl = `${SITE_URL}/l/${productId ?? cartId}?payment=cancelled`

  let providerData: Record<string, unknown>
  let redirectUrl: string
  let providerId: string

  // ── Stripe Connect ────────────────────────────────────────────────────────
  if (body.provider === 'stripe') {
    const stripeKey = process.env.STRIPE_SECRET_KEY
    if (!stripeKey) return res.status(500).json({ message: 'Stripe not configured' })

    const stripeClient = new Stripe(stripeKey, { apiVersion: '2025-09-30.clover' as any })

    const stripeSettings = sellerSettings.stripe as Record<string, unknown> | undefined
    const sellerStripeAccountId = stripeSettings?.account_id as string | undefined

    if (stripeSettings?.enabled === false || !sellerStripeAccountId || !stripeSettings?.charges_enabled) {
      return res.status(422).json({
        message: 'Este vendedor aún no ha activado los pagos. Contacta al vendedor directamente.',
        code: 'SELLER_NOT_CONNECTED',
      })
    }

    const session = await stripeClient.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency,
          unit_amount: priceCents,
          product_data: {
            name: productTitle,
            ...(productImage ? { images: [productImage] } : {}),
          },
        },
      }],
      payment_intent_data: {
        transfer_data: { destination: sellerStripeAccountId },
        application_fee_amount: 0,
      },
      customer_email: body.buyer_email,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        cart_id: cartId,
        product_id: productId ?? '',
        seller_id: seller?.id ?? '',
        ...(body.offer_id ? { offer_id: body.offer_id } : {}),
      },
    })

    providerData = {
      stripe_session_id: session.id,
      stripe_seller_account: sellerStripeAccountId,
      redirect_url: session.url!,
    }
    redirectUrl = session.url!
    providerId = 'pp_stripe-connect_stripe-connect'
  }

  // ── MercadoPago ───────────────────────────────────────────────────────────
  else {
    const mpToken = process.env.MP_ACCESS_TOKEN
    if (!mpToken) return res.status(500).json({ message: 'MercadoPago not configured' })

    if (sellerMeta.mp_enabled === false) {
      return res.status(422).json({
        message: 'Este vendedor no acepta Mercado Pago en este momento.',
        code: 'SELLER_MP_DISABLED',
      })
    }

    const prefPayload = {
      items: [{
        id: productId ?? cartId,
        title: productTitle,
        quantity: 1,
        unit_price: priceCents / 100,
        currency_id: currency.toUpperCase(),
      }],
      payer: body.buyer_email ? { email: body.buyer_email } : undefined,
      back_urls: {
        success: successUrl,
        failure: cancelUrl,
        pending: successUrl,
      },
      auto_return: 'approved',
      metadata: {
        cart_id: cartId,
        product_id: productId ?? '',
        seller_id: seller?.id ?? '',
        ...(body.offer_id ? { offer_id: body.offer_id } : {}),
      },
    }

    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mpToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(prefPayload),
    })
    const pref = await mpRes.json()

    if (!pref.id) {
      console.error('[start-checkout] MP preference creation failed:', pref)
      return res.status(500).json({ message: 'No se pudo crear la preferencia de pago.' })
    }

    const isDev = process.env.NODE_ENV !== 'production'
    const checkoutUrl = isDev ? pref.sandbox_init_point : pref.init_point

    providerData = {
      mp_preference_id: pref.id,
      redirect_url: checkoutUrl,
    }
    redirectUrl = checkoutUrl
    providerId = 'pp_mercadopago_mercadopago'
  }

  // ── Create Medusa PaymentCollection + PaymentSession ─────────────────────
  try {
    const paymentCollection = await paymentService.createPaymentCollections({
      currency_code: currency,
      amount: priceCents,
    })

    // createPaymentSession accepts a single session DTO (singular method name in v2)
    const paymentSession = await (paymentService as any).createPaymentSession(
      paymentCollection.id,
      {
        provider_id: providerId,
        data: providerData,
        amount: priceCents,
        currency_code: currency,
        context: {},
      }
    )

    // Patch the Stripe session metadata with the Medusa session ID (for webhook correlation)
    if (body.provider === 'stripe' && providerData.stripe_session_id) {
      // Best-effort — non-fatal if Stripe API call fails
      try {
        const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-09-30.clover' as any })
        await stripeClient.checkout.sessions.update(providerData.stripe_session_id as string, {
          metadata: {
            cart_id: cartId,
            medusa_payment_session_id: paymentSession.id,
          },
        })
      } catch { /* non-fatal */ }
    }

    // Link the payment collection to the cart (method availability varies by Medusa version)
    await (cartService as any).setPaymentCollection?.(cartId, paymentCollection.id).catch(() => {})

    return res.json({
      redirect_url: redirectUrl,
      cart_id: cartId,
      payment_session_id: paymentSession.id,
    })
  } catch (e) {
    console.error('[start-checkout] Medusa payment session error:', e)
    // Still return redirect_url even if Medusa session fails — user can pay,
    // and we reconcile via webhook
    return res.json({
      redirect_url: redirectUrl,
      cart_id: cartId,
      payment_session_id: null,
      _warning: 'Payment session not created in Medusa',
    })
  }
}
