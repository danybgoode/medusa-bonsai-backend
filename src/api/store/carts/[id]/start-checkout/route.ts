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
import { ICartModuleService, IPaymentModuleService } from '@medusajs/framework/types'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'

type FulfillmentMethod = 'local_pickup' | 'shipping' | 'digital' | 'service' | 'rental' | 'none'

type CheckoutShippingAddress = {
  name?: string
  phone?: string
  line1?: string
  line2?: string
  city?: string
  state?: string
  postal_code?: string
  country?: string
}

type CheckoutShippingQuote = {
  rate_id?: string
  carrier?: string
  service?: string
  amount_cents?: number
  currency?: string
  delivery_estimate?: number | null
  delivery_label?: string | null
}

function medusaAddress(input?: CheckoutShippingAddress | null) {
  if (!input) return null
  const [firstName, ...rest] = (input.name ?? '').trim().split(/\s+/).filter(Boolean)
  return {
    first_name: firstName || undefined,
    last_name: rest.join(' ') || undefined,
    phone: input.phone || undefined,
    address_1: input.line1 || undefined,
    address_2: input.line2 || undefined,
    city: input.city || undefined,
    province: input.state || undefined,
    postal_code: input.postal_code || undefined,
    country_code: (input.country || 'mx').toLowerCase(),
  }
}

function normalizeShippingQuote(input?: CheckoutShippingQuote | null) {
  if (!input) return null
  const amount = Math.max(0, Math.round(Number(input.amount_cents ?? 0)))
  if (!amount || !input.rate_id || !input.carrier || !input.service) return null
  return {
    rate_id: String(input.rate_id).slice(0, 500),
    carrier: String(input.carrier).slice(0, 60),
    service: String(input.service).slice(0, 120),
    amount_cents: amount,
    currency: String(input.currency ?? 'MXN').toUpperCase().slice(0, 3),
    delivery_estimate: input.delivery_estimate ?? null,
    delivery_label: input.delivery_label ? String(input.delivery_label).slice(0, 80) : null,
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id: cartId } = req.params
  const body = req.body as {
    provider: 'stripe' | 'mercadopago'
    buyer_email?: string
    offer_amount_cents?: number   // accepted offer override
    offer_id?: string             // Supabase offer ID for webhook reconciliation
    seller_id?: string            // skip expensive seller scan when caller already knows it
    fulfillment_method?: FulfillmentMethod
    pickup_spot_id?: string
    shipping_address?: CheckoutShippingAddress
    shipping_quote?: CheckoutShippingQuote
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
  const shippingQuote = normalizeShippingQuote(body.shipping_quote)
  const shippingCents = shippingQuote?.amount_cents ?? 0
  const checkoutTotalCents = priceCents + shippingCents

  if (!seller) {
    return res.status(422).json({
      message: 'Este anuncio aún no tiene vendedor registrado.',
      code: 'SELLER_NOT_CONNECTED',
    })
  }

  const sellerMeta = (seller.metadata ?? {}) as Record<string, unknown>
  const sellerSettings = (sellerMeta.settings ?? {}) as Record<string, unknown>
  const fulfillmentMethod = body.fulfillment_method ?? 'none'
  if (fulfillmentMethod === 'shipping' && !shippingQuote) {
    return res.status(400).json({ message: 'Selecciona una tarifa de envío para continuar.' })
  }
  const checkoutSelection = {
    payment_method: body.provider,
    fulfillment_method: fulfillmentMethod,
    pickup_spot_id: body.pickup_spot_id ?? null,
    has_shipping_address: !!body.shipping_address,
    shipping_quote: shippingQuote,
  }

  try {
    await cartService.updateCarts(cartId, {
      ...(body.shipping_address ? { shipping_address: medusaAddress(body.shipping_address) as any } : {}),
      metadata: {
        ...((cart as any).metadata ?? {}),
        checkout_selection: checkoutSelection,
        payment_method: body.provider,
        fulfillment_method: fulfillmentMethod,
        ...(shippingQuote ? {
          shipping_rate_id: shippingQuote.rate_id,
          shipping_carrier: shippingQuote.carrier,
          shipping_service: shippingQuote.service,
          shipping_amount_cents: shippingQuote.amount_cents,
          shipping_currency: shippingQuote.currency,
          shipping_delivery_estimate: shippingQuote.delivery_estimate,
          shipping_delivery_label: shippingQuote.delivery_label,
        } : {}),
        ...(body.pickup_spot_id ? { pickup_spot_id: body.pickup_spot_id } : {}),
        ...(body.seller_id ? { seller_id: body.seller_id } : {}),
        ...(body.offer_id ? { offer_id: body.offer_id } : {}),
      },
    } as any)
  } catch (e) {
    console.error('[start-checkout] cart selection update failed:', e)
  }

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

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{
      quantity: 1,
      price_data: {
        currency,
        unit_amount: priceCents,
        product_data: {
          name: productTitle,
          ...(productImage ? { images: [productImage] } : {}),
        },
      },
    }]
    if (shippingQuote && shippingCents > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency,
          unit_amount: shippingCents,
          product_data: {
            name: `Envío - ${shippingQuote.carrier.toUpperCase()} ${shippingQuote.service}`,
          },
        },
      })
    }

    const session = await stripeClient.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
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
        payment_method: 'stripe',
        fulfillment_method: fulfillmentMethod,
        ...(shippingQuote ? {
          shipping_rate_id: shippingQuote.rate_id,
          shipping_carrier: shippingQuote.carrier,
          shipping_service: shippingQuote.service,
          shipping_amount_cents: String(shippingQuote.amount_cents),
          shipping_currency: shippingQuote.currency,
          shipping_delivery_estimate: shippingQuote.delivery_estimate == null ? '' : String(shippingQuote.delivery_estimate),
          shipping_delivery_label: shippingQuote.delivery_label ?? '',
        } : {}),
        ...(body.pickup_spot_id ? { pickup_spot_id: body.pickup_spot_id } : {}),
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

    const mpItems = [{
        id: productId ?? cartId,
        title: productTitle,
        quantity: 1,
        unit_price: priceCents / 100,
        currency_id: currency.toUpperCase(),
      }]
    if (shippingQuote && shippingCents > 0) {
      mpItems.push({
        id: `${productId ?? cartId}-shipping`,
        title: `Envío - ${shippingQuote.carrier.toUpperCase()} ${shippingQuote.service}`,
        quantity: 1,
        unit_price: shippingCents / 100,
        currency_id: currency.toUpperCase(),
      })
    }

    const prefPayload = {
      items: mpItems,
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
        payment_method: 'mercadopago',
        fulfillment_method: fulfillmentMethod,
        ...(shippingQuote ? {
          shipping_rate_id: shippingQuote.rate_id,
          shipping_carrier: shippingQuote.carrier,
          shipping_service: shippingQuote.service,
          shipping_amount_cents: String(shippingQuote.amount_cents),
          shipping_currency: shippingQuote.currency,
          shipping_delivery_estimate: shippingQuote.delivery_estimate == null ? '' : String(shippingQuote.delivery_estimate),
          shipping_delivery_label: shippingQuote.delivery_label ?? '',
        } : {}),
        ...(body.pickup_spot_id ? { pickup_spot_id: body.pickup_spot_id } : {}),
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
      amount: checkoutTotalCents,
    })

    // createPaymentSession accepts a single session DTO (singular method name in v2)
    const paymentSession = await (paymentService as any).createPaymentSession(
      paymentCollection.id,
      {
        provider_id: providerId,
        data: providerData,
        amount: checkoutTotalCents,
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
    // Fail loudly: without a Medusa PaymentSession the cart can never be
    // completed into an order, so reconciliation can't recover it either.
    // Never hand the buyer a redirect to a payment we can't track — let them
    // retry (the orphaned provider session simply expires).
    return res.status(502).json({
      message: 'No se pudo inicializar el pago de forma segura. Intenta de nuevo en un momento.',
      code: 'PAYMENT_SESSION_FAILED',
    })
  }
}
