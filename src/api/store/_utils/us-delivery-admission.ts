/**
 * The US delivery/payment admission matrix — D16, enforcement half.
 *
 * The storefront has its own copy of these rules in `lib/checkout-market-strategy.ts`
 * so it can grey out an option before the buyer picks it. That copy is an OFFER gate.
 * This one is the authorization boundary: agents, UCP/MCP clients and stale in-flight
 * checkout pages POST straight to `start-checkout`, so a rule that lives only in the
 * storefront does not exist (AGENTS.md rule 3).
 *
 * Every refusal here is checked BEFORE the first authoritative write — no cart
 * mutation, no customer create, no Stripe call. A partial apply that returns 200 with
 * a warning is the anti-pattern this codebase has been bitten by repeatedly.
 */

export type AdmissionMarket = 'mx' | 'us'

export type UsDeliveryRefusalCode =
  | 'US_CARRIER_UNAVAILABLE'
  | 'US_CLIENT_SHIPPING_FORBIDDEN'
  | 'US_ADDRESS_REQUIRED'
  | 'US_ONLINE_PAYMENT_REQUIRED'

export type UsDeliveryAdmission =
  | { readonly ok: true; readonly shipping_amount_cents: number | null }
  | { readonly ok: false; readonly status: 422; readonly code: UsDeliveryRefusalCode; readonly message: string }

const MESSAGES: Record<UsDeliveryRefusalCode, string> = {
  // Honest, not apologetic: it says what IS available rather than implying an outage.
  US_CARRIER_UNAVAILABLE:
    'Carrier-rated shipping is not available in the US marketplace. Choose the seller\'s own shipping instead.',
  US_CLIENT_SHIPPING_FORBIDDEN:
    'Shipping cost cannot be supplied by the client on a US order.',
  US_ADDRESS_REQUIRED:
    'A shipping address is required for this delivery method.',
  US_ONLINE_PAYMENT_REQUIRED:
    'US orders are paid by card. The manual payment rails are Mexico-only.',
}

export interface UsDeliveryAdmissionInput {
  market: AdmissionMarket
  /** The buyer's chosen fulfillment method, already clamped to the known set. */
  fulfillmentMethod: string
  /** The payment provider id the caller asked for. */
  provider: string
  /** True when the caller sent a `shipping_quote` body fragment of any shape. */
  hasClientShippingQuote: boolean
  /**
   * The cart's shipping address, passed WHOLE rather than pre-reduced to a boolean.
   *
   * The first version took `hasShippingAddress: boolean` and the route computed it as
   * `address_1 || city` — so a cart carrying only `{ city: 'Austin' }` and no street
   * was admitted as deliverable. Deciding completeness at the call site is what let a
   * one-field address through; the rule lives here now, where it is tested.
   */
  shippingAddress: ShippingAddressLike | null | undefined
}

/** Medusa's cart shipping address, loosely typed — only the fields this rule reads. */
export interface ShippingAddressLike {
  address_1?: string | null
  city?: string | null
  province?: string | null
  postal_code?: string | null
  country_code?: string | null
}

/**
 * A US parcel needs a street, a city, a state and a ZIP. Anything less is not an
 * address a seller can put on a package, and admitting it means the seller discovers
 * the problem after the money has moved.
 */
export function isDeliverableUsAddress(address: ShippingAddressLike | null | undefined): boolean {
  if (!address) return false
  const present = (value: string | null | undefined) => typeof value === 'string' && value.trim().length > 0
  return (
    present(address.address_1) &&
    present(address.city) &&
    present(address.province) &&
    present(address.postal_code) &&
    address.country_code?.trim().toLowerCase() === 'us'
  )
}

/** Fulfillment methods that put a parcel in front of a buyer's door. */
const ADDRESSED_METHODS = new Set(['shipping', 'manual_carrier'])

/**
 * Payment providers that settle online. `coord`/manual delivery keeps its existing
 * manual-pay rule in both markets; this set is only about which RAIL a US order may
 * use, and the US has exactly one — Stripe. MercadoPago, SPEI, cash and DiMo are
 * Mexican instruments and none of them can settle a USD charge.
 */
const US_ONLINE_PROVIDERS = new Set(['stripe'])

export function admitUsDelivery(input: UsDeliveryAdmissionInput): UsDeliveryAdmission {
  const { market, fulfillmentMethod, provider, hasClientShippingQuote } = input

  // MX is untouched by construction — it returns before any US rule is consulted, so
  // no MX behaviour can change through this function no matter what is added below.
  if (market !== 'us') return { ok: true, shipping_amount_cents: null }

  const refuse = (code: UsDeliveryRefusalCode) =>
    ({ ok: false, status: 422, code, message: MESSAGES[code] }) as const

  // There is no US carrier. Envía and Correos are Mexican and S6 is stopped at its
  // evidence gate, so `shipping` would promise a rate at the quote seam that nothing
  // can produce. Refusing beats quoting a number we cannot honour.
  if (fulfillmentMethod === 'shipping') return refuse('US_CARRIER_UNAVAILABLE')

  // Money is server-authoritative. A US order has no rate seam at all, so ANY
  // client-supplied shipping quote is a caller inventing a number that would land in
  // the cart total.
  if (hasClientShippingQuote) return refuse('US_CLIENT_SHIPPING_FORBIDDEN')

  if (ADDRESSED_METHODS.has(fulfillmentMethod) && !isDeliverableUsAddress(input.shippingAddress)) {
    return refuse('US_ADDRESS_REQUIRED')
  }

  // `coord` is manual-pay in both markets by an older, broader rule that runs
  // upstream of this one; it is deliberately not re-stated here, because two copies
  // of one rule drift.
  if (fulfillmentMethod !== 'coord' && !US_ONLINE_PROVIDERS.has(provider)) {
    return refuse('US_ONLINE_PAYMENT_REQUIRED')
  }

  // Seller-funded: the buyer pays zero for delivery, and the number is ours, not the
  // caller's. Stated as 0 rather than null so the caller cannot read "no opinion".
  return { ok: true, shipping_amount_cents: 0 }
}

/**
 * Manual-carrier fulfillment REQUIRES a carrier and a tracking number (D16).
 *
 * The generic status transition defaults carrier to `'manual'` and tracking to
 * `null`, which is right for an MX arranged delivery where there may genuinely be no
 * tracking. It is wrong for `manual_carrier`, whose entire promise to the buyer is
 * "the seller sends you the tracking number" — marking such an order shipped with no
 * tracking makes the product lie on the order page, in the email and in the ledger.
 */
export function manualCarrierShipmentGap(input: {
  fulfillmentMethod: string | null | undefined
  newStatus: string
  carrier: string | null | undefined
  trackingNumber: string | null | undefined
}): { readonly missing: readonly string[] } {
  if (input.fulfillmentMethod !== 'manual_carrier') return { missing: [] }
  if (input.newStatus !== 'shipped' && input.newStatus !== 'in_transit') return { missing: [] }
  const missing: string[] = []
  // `'manual'` is the generic default, not a carrier a buyer can track a parcel with.
  if (!input.carrier?.trim() || input.carrier.trim() === 'manual') missing.push('carrier')
  if (!input.trackingNumber?.trim()) missing.push('tracking_number')
  return { missing }
}
