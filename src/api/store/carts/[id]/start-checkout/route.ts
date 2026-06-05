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
import { ICartModuleService, IPaymentModuleService, IPromotionModuleService } from '@medusajs/framework/types'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'
import { resolveSellerMpToken, sellerMpConnected, MP_MARKETPLACE_FEE_RATE } from '../../../_utils/mp'
import { resolveShippingOptionIds } from '../../../_utils/fulfillment'
import { extractClerkUserId, resolveOrCreateBuyerCustomer } from '../../../_utils/clerk-auth'
import { resolveCouponForCheckout, couponErrorMessage } from '../../../_utils/coupons'

// Maps the buyer's chosen fulfillment method to a seeded Medusa shipping option.
// Medusa's completeCart validation requires a shipping method on the cart when
// items require shipping — even for pickup/coordinated/manual delivery.
const OPTION_KEY_BY_METHOD: Record<string, 'shipping' | 'pickup' | 'digital' | 'coord'> = {
  shipping: 'shipping',
  local_pickup: 'pickup',
  digital: 'digital',
  service: 'coord',
  rental: 'coord',
  coord: 'coord',
  none: 'coord',
}

const SHIPPING_METHOD_LABEL: Record<string, string> = {
  shipping: 'Envío a domicilio',
  pickup: 'Recolección en mano',
  digital: 'Entrega digital',
  coord: 'Entrega acordada',
}

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'

// Escrow: 3-day auto-confirm window (buyer must confirm delivery; else auto-captured)
const ESCROW_AUTO_CAPTURE_DAYS = 3

type FulfillmentMethod = 'local_pickup' | 'shipping' | 'digital' | 'service' | 'rental' | 'none' | 'coord' | 'none'
type EscrowMode = 'off' | 'optional' | 'required'

// ── Bundle discount helpers ───────────────────────────────────────────────────

interface BundleTier {
  min_items: number
  percent_off: number
}

interface BundleSettings {
  enabled?: boolean
  tiers?: BundleTier[]
}

/**
 * Returns the best qualifying tier for `itemCount`, or null if no discount applies.
 * Highest min_items ≤ itemCount wins (Vinted-style tiered %).
 */
function resolveBundleTier(settings: BundleSettings | null | undefined, itemCount: number): BundleTier | null {
  if (!settings?.enabled || !settings.tiers?.length || itemCount < 2) return null
  const qualifying = settings.tiers
    .filter(t => t.min_items >= 2 && t.min_items <= itemCount && t.percent_off > 0 && t.percent_off <= 100)
    .sort((a, b) => b.min_items - a.min_items)
  return qualifying[0] ?? null
}

type CheckoutShippingAddress = {
  name?: string
  phone?: string
  /** Street name only */
  line1?: string
  /** Exterior number */
  ext_number?: string
  /** Interior number (optional) */
  int_number?: string
  /** Colonia */
  line2?: string
  /** Alcaldía / municipio (from CP lookup region_2) */
  city?: string
  state?: string
  /** Envia 2-digit state code */
  state_code?: string
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
  // Combine street + exterior number into address_1 for Medusa's single field
  const streetParts = [input.line1, input.ext_number].filter(Boolean)
  const address1 = streetParts.join(' ') || undefined
  // Interior number prepended to colonia in address_2
  const address2Parts = [
    input.int_number ? `Int ${input.int_number}` : '',
    input.line2 ?? '',
  ].filter(Boolean)
  const address2 = address2Parts.join(', ') || undefined
  return {
    first_name: firstName || undefined,
    last_name: rest.join(' ') || undefined,
    phone: input.phone || undefined,
    address_1: address1,
    address_2: address2,
    city: input.city || undefined,
    province: input.state_code || input.state || undefined,
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
    provider: 'stripe' | 'mercadopago' | 'spei' | 'cash' | 'manual'
    /** For provider 'manual': which structured instruction the buyer chose. */
    manual_sub_type?: 'clabe' | 'cash' | 'dimo'
    buyer_email?: string
    offer_amount_cents?: number   // accepted offer override
    coupon_code?: string          // seller coupon code applied at checkout
    offer_id?: string             // Supabase offer ID for webhook reconciliation
    seller_id?: string            // skip expensive seller scan when caller already knows it
    fulfillment_method?: FulfillmentMethod
    pickup_spot_id?: string
    shipping_address?: CheckoutShippingAddress
    shipping_quote?: CheckoutShippingQuote
    escrow?: boolean              // buyer explicitly opts in to escrow when mode='optional'
    origin_domain?: string        // tenant custom domain the buyer came from (own-channel hop)
  }

  if (!body.provider || !['stripe', 'mercadopago', 'spei', 'cash', 'manual'].includes(body.provider)) {
    return res.status(400).json({ message: 'provider is required: "stripe", "mercadopago", or "manual"' })
  }

  // Manual payments: one "Pago directo" method (legacy clients may still send
  // 'spei'/'cash'). All route to the unified pp_manual provider and are recorded
  // as metadata.payment_method = 'manual' with a snapshot of ALL the seller's
  // configured instructions (filled in the manual branch below).
  const isManual = body.provider === 'manual' || body.provider === 'spei' || body.provider === 'cash'

  // Own-channel hop: the buyer came from a tenant's custom domain and was sent to
  // the platform for the secure step. We record the origin domain + channel on the
  // cart (→ order metadata) so the success page can return them to their domain and
  // the sale is attributed `custom_domain`. Stored only — never used to build a
  // redirect here (the success page validates it against the verified-domain set
  // before redirecting, so a forged value can't become an open redirect).
  const originDomain = ((): string | null => {
    const raw = (body.origin_domain ?? '').trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!raw || raw.length > 253) return null
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(raw) ? raw : null
  })()

  // Rule: coordinated delivery (none/coord) requires manual payment coordination.
  // Card payments create buyer anxiety when there is no structured delivery path.
  const fulfillmentMethodEarly = body.fulfillment_method ?? 'none'
  if (
    (fulfillmentMethodEarly === 'none' || fulfillmentMethodEarly === 'coord') &&
    !isManual
  ) {
    return res.status(422).json({
      message: 'Este vendedor coordina la entrega personalmente. El pago debe acordarse junto con la entrega — usa pago directo (SPEI / efectivo).',
    })
  }

  const cartService: ICartModuleService = req.scope.resolve(Modules.CART)
  const paymentService: IPaymentModuleService = req.scope.resolve(Modules.PAYMENT)
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const remoteQuery = req.scope.resolve(ContainerRegistrationKeys.REMOTE_QUERY)

  // ── Load cart ─────────────────────────────────────────────────────────────
  // Only request relations within the cart module. `region` and `items.variant`
  // live in other modules and can't be populated here (MikroORM throws
  // "Entity 'Cart' does not have property 'region'"). Line items already carry
  // denormalized product_id / title / thumbnail, and the cart has currency_code.
  const [cart] = await cartService.listCarts(
    { id: cartId },
    { relations: ['items'] }
  )

  if (!cart) {
    return res.status(404).json({ message: 'Cart not found' })
  }

  // ── Link the buyer's Medusa customer to the cart ──────────────────────────
  // completeCart copies cart.customer_id → order.customer_id, which the buyer
  // order pages (/store/customers/me/orders) use for ownership. Resolve (or
  // create) the ONE canonical customer for this Clerk buyer — keyed by Clerk id
  // (customer.metadata.clerk_user_id) + email — and attach it, so the order is
  // owned by a stable, clerk-linked customer instead of a throwaway guest.
  if (!(cart as any).customer_id) {
    const clerkUserId = extractClerkUserId(req)
    if (clerkUserId) {
      try {
        const customerId = await resolveOrCreateBuyerCustomer(req.scope, {
          clerkUserId,
          email: (cart as any).email ?? body.buyer_email ?? null,
        })
        if (customerId) {
          await cartService.updateCarts(cartId, { customer_id: customerId } as any)
        }
      } catch (e) {
        console.error('[start-checkout] customer link failed:', e)
      }
    }
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
  // A plain listCarts may not compute `total`; fall back to summing line items
  // (same unit as cart.total — variant prices are stored as integer cents).
  const itemsTotalCents = (cart.items ?? []).reduce(
    (sum: number, i: any) => sum + Math.round(Number(i.unit_price ?? 0) * Number(i.quantity ?? 1)),
    0,
  )
  const rawItemsCents = body.offer_amount_cents ?? (Math.round(Number(cart.total ?? 0)) || itemsTotalCents)
  const shippingQuote = normalizeShippingQuote(body.shipping_quote)
  const shippingCents = shippingQuote?.amount_cents ?? 0
  // priceCents and checkoutTotalCents are finalized after bundle discount is resolved below

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

  // ── Bundle discount (tiered %) ────────────────────────────────────────────
  // Applied to item subtotal only (not shipping). Ignored when buyer has an accepted
  // offer override (offer_amount_cents already reflects an agreed price).
  const bundleSettings = (sellerSettings.bundles ?? null) as BundleSettings | null
  const itemCount = (cart.items ?? []).length
  const bundleTier = body.offer_amount_cents ? null : resolveBundleTier(bundleSettings, itemCount)
  const bundleDiscountCents = bundleTier
    ? Math.round(itemsTotalCents * bundleTier.percent_off / 100)
    : 0

  // ── Coupon code (seller-scoped) ───────────────────────────────────────────
  // Applied on the post-bundle item subtotal. Like the bundle discount, it's
  // ignored when an accepted offer override is present. Validated against the
  // Promotion module + the seller's own coupon_ids; a bad code fails the
  // checkout loudly so the buyer never silently pays full price.
  const postBundleBase = Math.max(0, rawItemsCents - bundleDiscountCents)
  let couponInfo: { code: string; promotion_id: string; discount_cents: number } | null = null
  let couponDiscountCents = 0
  if (body.coupon_code && !body.offer_amount_cents) {
    const couponIds = Array.isArray((sellerMeta as any).coupon_ids) ? (sellerMeta as any).coupon_ids as string[] : []
    const promotionService = req.scope.resolve(Modules.PROMOTION) as IPromotionModuleService
    const resolution = await resolveCouponForCheckout(promotionService, body.coupon_code, couponIds, postBundleBase)
    if (!resolution.ok) {
      return res.status(422).json({ message: couponErrorMessage(resolution.reason), code: 'COUPON_INVALID' })
    }
    couponDiscountCents = resolution.discount_cents
    couponInfo = { code: resolution.code, promotion_id: resolution.promotion_id, discount_cents: couponDiscountCents }
  }

  // priceCents = item charge after discounts (providers bill this); checkoutTotalCents adds shipping
  const priceCents = Math.max(0, rawItemsCents - bundleDiscountCents - couponDiscountCents)
  const checkoutTotalCents = priceCents + shippingCents

  // ── Escrow mode is resolved early so it can be written to cart metadata before the payment branch
  const checkoutSettings = (sellerSettings.checkout ?? {}) as Record<string, unknown>
  const escrowModeSetting = (checkoutSettings.escrow_mode ?? 'off') as EscrowMode
  const useEscrow = escrowModeSetting === 'required' || (escrowModeSetting === 'optional' && body.escrow === true)

  // payment_method recorded on the order: 'manual' for all direct payments,
  // otherwise the gateway id.
  const effectivePaymentMethod = isManual ? 'manual' : body.provider

  // ── Manual instruction snapshot ───────────────────────────────────────────
  // Capture ALL of the seller's configured direct-payment methods so the order /
  // success page + emails show everything at once (buyer chooses how to pay).
  let manualPaymentSnapshot: { spei: unknown; dimo: unknown; cash: unknown } | null = null
  if (isManual) {
    const bankTransfer = (checkoutSettings.bank_transfer ?? {}) as Record<string, unknown>
    const clabe = typeof bankTransfer.clabe === 'string' ? bankTransfer.clabe.replace(/\D/g, '') : ''
    const spei = (bankTransfer.enabled !== false && clabe.length === 18)
      ? { clabe, bank_name: (bankTransfer.bank_name as string | undefined) ?? null, account_holder: (bankTransfer.account_holder as string | undefined) ?? null }
      : null

    const dimoConfig = (checkoutSettings.dimo ?? {}) as Record<string, unknown>
    const dimoPhone = typeof dimoConfig.phone === 'string' ? dimoConfig.phone.replace(/\D/g, '') : ''
    const dimo = (dimoConfig.enabled === true && dimoPhone.length >= 10) ? { phone: dimoPhone } : null

    const cashConfig = (checkoutSettings.cash_pickup ?? {}) as Record<string, unknown>
    const cash = (cashConfig.enabled !== false && fulfillmentMethod === 'local_pickup')
      ? { note: (cashConfig.note as string | undefined) ?? null }
      : null

    if (!spei && !dimo && !cash) {
      return res.status(422).json({
        message: 'Este vendedor no tiene métodos de pago directo configurados. Contáctalo directamente.',
        code: 'SELLER_MANUAL_MISSING',
      })
    }
    manualPaymentSnapshot = { spei, dimo, cash }
  }

  const checkoutSelection = {
    payment_method: effectivePaymentMethod,
    fulfillment_method: fulfillmentMethod,
    pickup_spot_id: body.pickup_spot_id ?? null,
    has_shipping_address: !!body.shipping_address,
    shipping_quote: shippingQuote,
    escrow_mode: useEscrow ? escrowModeSetting : null,
    ...(bundleTier ? {
      bundle_discount: {
        percent_off: bundleTier.percent_off,
        discount_cents: bundleDiscountCents,
        item_count: itemCount,
        tier_min_items: bundleTier.min_items,
      },
    } : {}),
    ...(couponInfo ? { coupon: couponInfo } : {}),
  }

  try {
    await cartService.updateCarts(cartId, {
      ...(body.shipping_address ? { shipping_address: medusaAddress(body.shipping_address) as any } : {}),
      metadata: {
        ...((cart as any).metadata ?? {}),
        checkout_selection: checkoutSelection,
        payment_method: effectivePaymentMethod,
        ...(manualPaymentSnapshot ? { manual_payment: manualPaymentSnapshot } : {}),
        fulfillment_method: fulfillmentMethod,
        ...(useEscrow ? { escrow_mode: escrowModeSetting } : {}),
        ...(bundleTier ? {
          bundle_discount_pct: bundleTier.percent_off,
          bundle_discount_cents: bundleDiscountCents,
        } : {}),
        // Carried onto the order (cart.metadata → order.metadata) so the
        // order.placed subscriber can register coupon usage exactly once.
        ...(couponInfo ? { coupon: couponInfo } : {}),
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
        // Own-channel attribution + return target (see originDomain above).
        ...(originDomain ? { origin_domain: originDomain, channel: 'custom_domain' } : {}),
      },
    } as any)
  } catch (e) {
    console.error('[start-checkout] cart selection update failed:', e)
  }

  // ── Attach a Medusa shipping method ───────────────────────────────────────
  // completeCart rejects carts whose items require shipping but have no shipping
  // method — this hit every pickup/SPEI/coordinated checkout. We add the seeded
  // option that matches the chosen fulfillment method, with an explicit amount
  // (the quoted rate for shipping, $0 for pickup/coordinated/digital) so we don't
  // depend on the calculated-price provider call.
  try {
    const optionIds = await resolveShippingOptionIds(req.scope)
    const optionKey = OPTION_KEY_BY_METHOD[fulfillmentMethod] ?? 'coord'
    const shippingOptionId = optionIds[optionKey] ?? optionIds.coord
    if (shippingOptionId) {
      const methodAmount = fulfillmentMethod === 'shipping' ? shippingCents : 0
      await (cartService as any).addShippingMethods(cartId, [{
        name: SHIPPING_METHOD_LABEL[optionKey] ?? 'Entrega',
        amount: methodAmount,
        shipping_option_id: shippingOptionId,
        data: {},
      }])
    } else {
      console.warn('[start-checkout] no seeded shipping option found — run /internal/setup-fulfillment')
    }
  } catch (e) {
    console.error('[start-checkout] addShippingMethods failed:', e)
  }

  const successUrl = `${SITE_URL}/payment/success?cart_id=${cartId}`
  const cancelUrl = `${SITE_URL}/l/${productId ?? cartId}?payment=cancelled`

  let providerData: Record<string, unknown> = {}
  let redirectUrl: string | null = null
  let providerId = 'pp_system_default'

  // ── Manual ("Pago directo": SPEI / DiMo / cash) ───────────────────────────
  // Snapshot was already computed + validated above; route to the unified manual
  // provider. Legacy pp_spei/pp_cash remain registered for in-flight orders.
  if (isManual) {
    providerData = {
      payment_method: 'manual',
      manual_payment: manualPaymentSnapshot,
      payment_received: false,
    }
    redirectUrl = null
    providerId = 'pp_manual_manual'
  }

  // ── Stripe Connect ────────────────────────────────────────────────────────
  else if (body.provider === 'stripe') {
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
        // Escrow: hold funds until buyer confirms delivery or auto-confirm window elapses
        ...(useEscrow ? { capture_method: 'manual' } : {}),
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
        ...(useEscrow ? { escrow_mode: escrowModeSetting } : {}),
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
      ...(useEscrow ? { escrow_mode: escrowModeSetting } : {}),
    }
    redirectUrl = session.url!
    providerId = 'pp_stripe-connect_stripe-connect'
  }

  // ── MercadoPago ───────────────────────────────────────────────────────────
  else if (body.provider === 'mercadopago') {
    if (!sellerMpConnected(seller)) {
      return res.status(422).json({
        message: 'Este vendedor aún no ha conectado Mercado Pago.',
        code: 'SELLER_MP_NOT_CONNECTED',
      })
    }

    const sellerMpToken = await resolveSellerMpToken(sellerService, seller)
    if (!sellerMpToken) {
      return res.status(422).json({
        message: 'La conexión de Mercado Pago del vendedor expiró. Pídele que la reconecte.',
        code: 'MP_TOKEN_EXPIRED',
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

    // 0% platform fee by default (MP marketplace_fee is an absolute amount).
    const marketplaceFee = Math.round(checkoutTotalCents * MP_MARKETPLACE_FEE_RATE) / 100

    // Canonical Checkout Pro marketplace preference — minimal + to MP spec.
    // Deliberately NO `payer`: pre-setting payer.email makes MP lock the email on
    // the hosted page and can leave the "Pagar" button disabled when the buyer
    // pays with a different MP account. Checkout Pro collects the payer itself.
    const prefPayload = {
      items: mpItems,
      ...(marketplaceFee > 0 ? { marketplace_fee: marketplaceFee } : {}),
      notification_url: `${SITE_URL}/api/webhooks/mercadopago?seller_id=${encodeURIComponent(seller.id)}`,
      external_reference: cartId,
      statement_descriptor: 'MIYAGI SANCHEZ',
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
        Authorization: `Bearer ${sellerMpToken}`,
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

    // Link the payment collection to the cart. cart ↔ payment_collection is a
    // *module link* (it lives in the Link module, not as a column on either
    // entity), so it MUST be created via the Link service — exactly as Medusa's
    // own createPaymentCollectionForCartWorkflow does. The previous
    // `cartService.setPaymentCollection?.()` was a no-op (no such method on the
    // v2 Cart service), so the collection was created but never attached. Without
    // this link, POST /complete fails with "Payment collection has not been
    // initiated for cart" — payment succeeds at the provider but no Medusa order
    // is ever created. A failure here throws into the catch below (502) rather
    // than handing the buyer a payment we can never turn into an order.
    const remoteLink = req.scope.resolve(ContainerRegistrationKeys.LINK)
    await remoteLink.create({
      [Modules.CART]: { cart_id: cartId },
      [Modules.PAYMENT]: { payment_collection_id: paymentCollection.id },
    })

    const responseBody: Record<string, unknown> = {
      redirect_url: redirectUrl,
      cart_id: cartId,
      payment_session_id: paymentSession.id,
    }
    // For manual payments: include the full instruction snapshot so the success
    // page can show every configured method (SPEI / DiMo / cash) at once.
    if (isManual) {
      responseBody.payment_method = 'manual'
      responseBody.manual_payment = manualPaymentSnapshot
    }
    // For escrow: include the mode so frontend can show escrow badge
    if (useEscrow) {
      responseBody.escrow_mode = escrowModeSetting
    }
    // Bundle discount applied
    if (bundleTier) {
      responseBody.bundle_discount = {
        percent_off: bundleTier.percent_off,
        discount_cents: bundleDiscountCents,
        item_count: itemCount,
      }
    }
    // Coupon applied
    if (couponInfo) {
      responseBody.coupon = couponInfo
    }
    return res.json(responseBody)
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
