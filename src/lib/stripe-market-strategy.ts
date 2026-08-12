import type Stripe from 'stripe'
import { readSellerOperatingMarket } from './seller-market'
import { MARKETS, type MarketCode } from './markets'

export type StripeChargeStrategy = 'destination_charge' | 'direct_charge'

export type StripePaymentContext = {
  stripe_market: MarketCode
  stripe_strategy: StripeChargeStrategy
  stripe_account_id: string
  stripe_session_id: string | null
  stripe_payment_intent: string | null
  stripe_charge_id: string | null
  stripe_currency: string
}

export type StripeReadiness = {
  ready: boolean
  reason: string | null
  account_id: string | null
  blocking_requirements: string[]
}

type StripeSettings = Record<string, unknown>

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

export function readSellerStripeSettings(seller: unknown): StripeSettings {
  const row = (seller && typeof seller === 'object' ? seller : {}) as Record<string, unknown>
  const metadata = (row.metadata && typeof row.metadata === 'object' ? row.metadata : row) as Record<string, unknown>
  const settings = (metadata.settings && typeof metadata.settings === 'object' ? metadata.settings : {}) as Record<string, unknown>
  return (settings.stripe && typeof settings.stripe === 'object' ? settings.stripe : {}) as StripeSettings
}

/**
 * Market-specific Stripe readiness. MX intentionally preserves the legacy v1
 * population; US requires the Accounts v2 merchant shape proven in D14.
 */
export function resolveStripeReadiness(seller: unknown): StripeReadiness {
  const marketRead = readSellerOperatingMarket(seller)
  if (!marketRead.market) {
    return { ready: false, reason: 'SELLER_MARKET_INVALID', account_id: null, blocking_requirements: [] }
  }
  const stripe = readSellerStripeSettings(seller)
  const accountId = typeof stripe.account_id === 'string' && stripe.account_id ? stripe.account_id : null
  const blocking = stringArray(stripe.blocking_requirements)
  if (stripe.enabled === false || !accountId) {
    return { ready: false, reason: 'SELLER_STRIPE_ACCOUNT_MISSING', account_id: accountId, blocking_requirements: blocking }
  }
  if (marketRead.market === 'mx') {
    const ready = stripe.charges_enabled === true
    return { ready, reason: ready ? null : 'SELLER_STRIPE_CHARGES_DISABLED', account_id: accountId, blocking_requirements: blocking }
  }

  if (stripe.api_generation !== 'v2') {
    return { ready: false, reason: 'SELLER_STRIPE_V2_REQUIRED', account_id: accountId, blocking_requirements: blocking }
  }
  if (String(stripe.account_country ?? '').toLowerCase() !== 'us') {
    return { ready: false, reason: 'SELLER_STRIPE_COUNTRY_MISMATCH', account_id: accountId, blocking_requirements: blocking }
  }
  if (stripe.merchant_configuration !== 'active') {
    return { ready: false, reason: 'SELLER_STRIPE_MERCHANT_INACTIVE', account_id: accountId, blocking_requirements: blocking }
  }
  // MEASURED against a real Accounts v2 account (2026-08-11): the merchant
  // configuration exposes exactly ONE capability carrying a status — `card_payments`
  // — and `configuration.recipient` comes back empty. There is no payouts capability
  // to read at all. Requiring `payouts_status === 'active'` here, as this originally
  // did, made US readiness UNSATISFIABLE: no US seller could ever have taken a
  // payment, and no unit test would have noticed, because a fixture can assert a
  // field the real API never returns.
  //
  // Payouts are also not the platform's gate in this model. The account holds a full
  // dashboard and Stripe collects both fees and losses, so it manages its own
  // payouts. What gates taking a DIRECT CHARGE is card payments plus the absence of
  // blocking requirements.
  if (stripe.card_payments_status !== 'active') {
    return { ready: false, reason: 'SELLER_STRIPE_CAPABILITY_INACTIVE', account_id: accountId, blocking_requirements: blocking }
  }
  // Three states, not two: an ABSENT payouts status is unknown and does not block,
  // but one reported explicitly non-active is a real signal and does.
  if (stripe.payouts_status != null && stripe.payouts_status !== 'active') {
    return { ready: false, reason: 'SELLER_STRIPE_PAYOUTS_INACTIVE', account_id: accountId, blocking_requirements: blocking }
  }
  if (blocking.length > 0) {
    return { ready: false, reason: 'SELLER_STRIPE_REQUIREMENTS_DUE', account_id: accountId, blocking_requirements: blocking }
  }
  return { ready: true, reason: null, account_id: accountId, blocking_requirements: [] }
}

export type StripeStrategyPlan =
  | {
      ok: true
      market: MarketCode
      strategy: StripeChargeStrategy
      currency: string
      account_id: string
      request_options: Stripe.RequestOptions | undefined
      payment_intent_data: Stripe.Checkout.SessionCreateParams.PaymentIntentData
    }
  | { ok: false; status: 422 | 503; code: string; message: string; market: MarketCode | null }

export function planStripeMarketStrategy(input: {
  seller: unknown
  cart_currency: unknown
  cart_region_id?: string | null
  expected_region_id?: string | null
}): StripeStrategyPlan {
  const marketRead = readSellerOperatingMarket(input.seller)
  if (!marketRead.market) {
    return { ok: false, status: 422, code: 'SELLER_MARKET_INVALID', message: 'The seller has an invalid operating market.', market: null }
  }
  const expectedCurrency = MARKETS[marketRead.market].currency_code
  const currency = String(input.cart_currency ?? '').toLowerCase()
  if (currency !== expectedCurrency) {
    return { ok: false, status: 422, code: 'CHECKOUT_CURRENCY_MISMATCH', message: `Expected ${expectedCurrency.toUpperCase()} for market ${marketRead.market.toUpperCase()}.`, market: marketRead.market }
  }
  if (input.expected_region_id && input.cart_region_id !== input.expected_region_id) {
    return { ok: false, status: 422, code: 'CHECKOUT_REGION_MISMATCH', message: 'The cart Region does not belong to the seller market.', market: marketRead.market }
  }
  const readiness = resolveStripeReadiness(input.seller)
  if (!readiness.ready || !readiness.account_id) {
    return {
      ok: false,
      status: readiness.reason === 'SELLER_STRIPE_ACCOUNT_MISSING' ? 422 : 503,
      code: readiness.reason ?? 'SELLER_STRIPE_NOT_READY',
      message: 'This seller is not ready to accept Stripe payments.',
      market: marketRead.market,
    }
  }
  if (marketRead.market === 'us') {
    return {
      ok: true,
      market: 'us',
      strategy: 'direct_charge',
      currency,
      account_id: readiness.account_id,
      request_options: { stripeAccount: readiness.account_id },
      payment_intent_data: {},
    }
  }
  return {
    ok: true,
    market: 'mx',
    strategy: 'destination_charge',
    currency,
    account_id: readiness.account_id,
    request_options: undefined,
    payment_intent_data: {
      transfer_data: { destination: readiness.account_id },
      application_fee_amount: 0,
    },
  }
}

export interface CheckoutRefusal {
  readonly status: number
  readonly body: { readonly message: string; readonly code: string }
}

/**
 * MX's refusal wire contract is FROZEN. `BuyButton.tsx` and `CheckoutPayButton.tsx`
 * both branch on the literal string `SELLER_NOT_CONNECTED` to show the friendly
 * "this seller hasn't enabled payments" copy; letting the richer per-reason codes
 * introduced here reach an MX buyer would replace that with a raw error string.
 * The epic forbids any change to MX behaviour, so MX keeps its exact status, code
 * and Spanish message no matter which readiness check actually failed.
 *
 * An unresolvable market gets the same frozen MX refusal: it is the safe, already
 * user-facing copy, and we must not assert a market we could not read.
 *
 * US is new surface with no legacy consumer, so it returns the specific reason —
 * that is D13/D15's "honest reason" rather than a generic failure.
 */
const MX_FROZEN_REFUSAL: CheckoutRefusal = Object.freeze({
  status: 422,
  body: Object.freeze({
    message: 'Este vendedor aún no ha activado los pagos. Contacta al vendedor directamente.',
    code: 'SELLER_NOT_CONNECTED',
  }),
})

export function checkoutRefusalResponse(plan: Extract<StripeStrategyPlan, { ok: false }>): CheckoutRefusal {
  if (plan.market !== 'us') return MX_FROZEN_REFUSAL
  return Object.freeze({ status: plan.status, body: Object.freeze({ message: plan.message, code: plan.code }) })
}

export function buildStripePaymentContext(
  plan: Extract<StripeStrategyPlan, { ok: true }>,
  ids: Partial<Pick<StripePaymentContext, 'stripe_session_id' | 'stripe_payment_intent' | 'stripe_charge_id'>> = {},
): StripePaymentContext {
  return {
    stripe_market: plan.market,
    stripe_strategy: plan.strategy,
    stripe_account_id: plan.account_id,
    stripe_session_id: ids.stripe_session_id ?? null,
    stripe_payment_intent: ids.stripe_payment_intent ?? null,
    stripe_charge_id: ids.stripe_charge_id ?? null,
    stripe_currency: plan.currency,
  }
}

/** Durable data only. Legacy MX sessions are deliberately tolerated in-flight. */
export function readStripePaymentContext(data: Record<string, unknown>): StripePaymentContext | null {
  const legacyAccount = typeof data.stripe_seller_account === 'string' ? data.stripe_seller_account : null
  const accountId = typeof data.stripe_account_id === 'string' ? data.stripe_account_id : legacyAccount
  if (!accountId) return null
  const market = data.stripe_market === 'us' ? 'us' : 'mx'
  const strategy: StripeChargeStrategy = data.stripe_strategy === 'direct_charge' ? 'direct_charge' : 'destination_charge'
  if ((market === 'us') !== (strategy === 'direct_charge')) return null
  const currency = typeof data.stripe_currency === 'string' ? data.stripe_currency.toLowerCase() : (market === 'us' ? 'usd' : 'mxn')
  if (currency !== MARKETS[market].currency_code) return null
  return {
    stripe_market: market,
    stripe_strategy: strategy,
    stripe_account_id: accountId,
    stripe_session_id: typeof data.stripe_session_id === 'string' ? data.stripe_session_id : null,
    stripe_payment_intent: typeof data.stripe_payment_intent === 'string' ? data.stripe_payment_intent : null,
    stripe_charge_id: typeof data.stripe_charge_id === 'string' ? data.stripe_charge_id : null,
    stripe_currency: currency,
  }
}

export function stripeRequestOptions(context: StripePaymentContext): Stripe.RequestOptions | undefined {
  return context.stripe_strategy === 'direct_charge'
    ? { stripeAccount: context.stripe_account_id }
    : undefined
}

export function stripeRefundParams(context: StripePaymentContext, amount?: number): Stripe.RefundCreateParams {
  return {
    payment_intent: context.stripe_payment_intent ?? undefined,
    charge: context.stripe_payment_intent ? undefined : (context.stripe_charge_id ?? undefined),
    amount,
    ...(context.stripe_strategy === 'destination_charge' ? { reverse_transfer: true } : {}),
  }
}

export function webhookMatchesPaymentContext(event: Stripe.Event, session: Stripe.Checkout.Session): boolean {
  const metadata = session.metadata ?? {}
  const strategy = metadata.stripe_strategy
  const accountId = metadata.stripe_account_id
  if (strategy === 'direct_charge') return !!accountId && event.account === accountId
  if (strategy === 'destination_charge') return !event.account
  return false
}
