import fs from 'node:fs'
import path from 'node:path'
import {
  readStripePaymentContext,
  stripeRefundParams,
  stripeRequestOptions,
} from '../../../lib/stripe-market-strategy'

/**
 * Every Stripe lifecycle call must address the account the charge actually lives on.
 *
 * The provider originally made all six calls in platform context. For a US DIRECT
 * charge — which lives on the seller's connected account — `sessions.retrieve` 404s,
 * so `authorizePayment` returned `error`, the cart never completed, and the buyer was
 * charged with no order, no fulfilment and no email. `capturePayment` was worse: the
 * escrow hold expires after ~7 days and the money returns AFTER the seller shipped.
 *
 * These specs pin the DERIVATION the provider now uses for its request options and
 * refund shape, on both the US path and the legacy MX path that must not change.
 */

const US_SESSION = {
  stripe_market: 'us',
  stripe_strategy: 'direct_charge',
  stripe_account_id: 'acct_us_seller',
  stripe_session_id: 'cs_us',
  stripe_payment_intent: 'pi_us',
  stripe_charge_id: 'ch_us',
  stripe_currency: 'usd',
}

const MX_SESSION = {
  stripe_market: 'mx',
  stripe_strategy: 'destination_charge',
  stripe_account_id: 'acct_mx_seller',
  stripe_session_id: 'cs_mx',
  stripe_payment_intent: 'pi_mx',
  stripe_charge_id: 'ch_mx',
  stripe_currency: 'mxn',
}

/** Exactly what a session written before this epic looks like. */
const LEGACY_MX_SESSION = {
  stripe_session_id: 'cs_legacy',
  stripe_seller_account: 'acct_mx_legacy',
  stripe_payment_intent: 'pi_legacy',
}

function optionsFor(data: Record<string, unknown>) {
  const context = readStripePaymentContext(data)
  return context ? stripeRequestOptions(context) : undefined
}

describe('lifecycle request context — the account the charge lives on', () => {
  it('US addresses the connected account on every call', () => {
    expect(optionsFor(US_SESSION)).toEqual({ stripeAccount: 'acct_us_seller' })
  })

  it('MX stays in PLATFORM context — a destination charge is a platform charge', () => {
    expect(optionsFor(MX_SESSION)).toBeUndefined()
  })

  // The regression that matters most: sessions created before this epic must behave
  // exactly as they did, or in-flight MX checkouts break at the deploy boundary.
  it('a LEGACY MX session resolves to platform context, unchanged', () => {
    expect(optionsFor(LEGACY_MX_SESSION)).toBeUndefined()
  })

  it('an unreadable session falls back to platform context rather than guessing an account', () => {
    expect(optionsFor({})).toBeUndefined()
    expect(optionsFor({ stripe_session_id: 'cs_x' })).toBeUndefined()
  })
})

describe('refund shape — reverse_transfer is derived, never assumed', () => {
  it('a US direct refund omits reverse_transfer (Stripe rejects it on a direct charge)', () => {
    const context = readStripePaymentContext(US_SESSION)!
    const params = stripeRefundParams(context, 1800)
    expect(params).not.toHaveProperty('reverse_transfer')
    expect(params).toMatchObject({ payment_intent: 'pi_us', amount: 1800 })
  })

  it('an MX destination refund keeps reverse_transfer', () => {
    const context = readStripePaymentContext(MX_SESSION)!
    expect(stripeRefundParams(context)).toMatchObject({ payment_intent: 'pi_mx', reverse_transfer: true })
  })

  it('a legacy MX refund also keeps reverse_transfer — behaviour preserved', () => {
    const context = readStripePaymentContext(LEGACY_MX_SESSION)!
    expect(stripeRefundParams(context)).toMatchObject({ reverse_transfer: true })
  })

  it('a US refund is issued against the connected account', () => {
    const context = readStripePaymentContext(US_SESSION)!
    expect(stripeRequestOptions(context)).toEqual({ stripeAccount: 'acct_us_seller' })
  })
})

describe('the provider actually consumes the derivation', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/modules/payment-stripe-connect/service.ts'), 'utf8',
  )

  // The helpers existed and were fully tested BEFORE anything called them — which is
  // precisely how the hole survived review. Assert the wiring, not just the logic.
  it.each([
    ['checkout.sessions.retrieve'],
    ['paymentIntents.capture'],
    ['paymentIntents.cancel'],
    ['checkout.sessions.expire'],
    ['refunds.create'],
  ])('%s passes request options', (call) => {
    const idx = source.indexOf(call)
    // jest's expect takes one argument — the label lives in the test name instead.
    expect(idx).toBeGreaterThan(-1)
    const window = source.slice(idx, idx + 400)
    expect(window).toMatch(/requestContextFor\(data\)|options,?\n|options\)/)
  })

  it('no lifecycle Stripe call is left in bare platform context', () => {
    expect(source).not.toMatch(/sessions\.retrieve\(sessionId\)/)
    expect(source).not.toMatch(/paymentIntents\.capture\(pi\)/)
    expect(source).not.toMatch(/paymentIntents\.cancel\(pi\)/)
    expect(source).not.toMatch(/sessions\.expire\(sessionId\)/)
  })

  // Asserting the ABSENCE of a hard-coded literal is too weak — a regression can
  // reintroduce it in a shape the pattern misses, and the spec passes vacuously.
  // (It did: hard-coding the refund params again left this green until the assertion
  // was changed to demand the derivation POSITIVELY.)
  it('the refund derives its params from the payment context', () => {
    const idx = source.indexOf('refunds.create')
    expect(idx).toBeGreaterThan(-1)
    const window = source.slice(idx, idx + 400)
    expect(window).toContain('stripeRefundParams(context')
  })
})
