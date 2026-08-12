import {
  buildStripePaymentContext,
  checkoutRefusalResponse,
  planStripeMarketStrategy,
  readStripePaymentContext,
  resolveStripeReadiness,
  stripeRefundParams,
  stripeRequestOptions,
  webhookMatchesPaymentContext,
} from '../stripe-market-strategy'

const mxSeller = {
  metadata: { operating_market: 'mx', settings: { stripe: { account_id: 'acct_mx', charges_enabled: true } } },
}
const usSeller = {
  metadata: { operating_market: 'us', settings: { stripe: {
    account_id: 'acct_us', api_generation: 'v2', account_country: 'us',
    merchant_configuration: 'active', card_payments_status: 'active',
    blocking_requirements: [],
  } } },
}

describe('Stripe market strategy — D14–D16', () => {
  it('preserves MX destination charges in platform context', () => {
    const plan = planStripeMarketStrategy({ seller: mxSeller, cart_currency: 'mxn' })
    expect(plan).toMatchObject({ ok: true, market: 'mx', strategy: 'destination_charge', request_options: undefined })
    if (!plan.ok) throw new Error('expected plan')
    expect(plan.payment_intent_data).toEqual({ transfer_data: { destination: 'acct_mx' }, application_fee_amount: 0 })
  })

  it('plans US direct charges in the connected-account context with no transfer/application fee', () => {
    const plan = planStripeMarketStrategy({ seller: usSeller, cart_currency: 'USD' })
    expect(plan).toMatchObject({ ok: true, market: 'us', strategy: 'direct_charge', request_options: { stripeAccount: 'acct_us' }, payment_intent_data: {} })
  })

  it('refuses currency and Region mixing before a write', () => {
    expect(planStripeMarketStrategy({ seller: usSeller, cart_currency: 'mxn' })).toMatchObject({ ok: false, code: 'CHECKOUT_CURRENCY_MISMATCH' })
    expect(planStripeMarketStrategy({ seller: usSeller, cart_currency: 'usd', cart_region_id: 'reg_mx', expected_region_id: 'reg_us' })).toMatchObject({ ok: false, code: 'CHECKOUT_REGION_MISMATCH' })
  })

  it('requires the complete Accounts v2 US readiness matrix', () => {
    const base = (usSeller.metadata.settings.stripe as Record<string, unknown>)
    for (const [key, value, reason] of [
      ['api_generation', 'v1', 'SELLER_STRIPE_V2_REQUIRED'],
      ['account_country', 'mx', 'SELLER_STRIPE_COUNTRY_MISMATCH'],
      ['merchant_configuration', 'inactive', 'SELLER_STRIPE_MERCHANT_INACTIVE'],
      ['card_payments_status', 'pending', 'SELLER_STRIPE_CAPABILITY_INACTIVE'],
      // Its own reason, not the card-payments one: a real v2 account reports no
      // payouts capability at all, so an explicitly non-active value is a distinct
      // and much rarer signal worth naming separately.
      ['payouts_status', 'pending', 'SELLER_STRIPE_PAYOUTS_INACTIVE'],
    ] as const) {
      const seller = { metadata: { operating_market: 'us', settings: { stripe: { ...base, [key]: value } } } }
      expect(resolveStripeReadiness(seller)).toMatchObject({ ready: false, reason })
    }
    const blocked = { metadata: { operating_market: 'us', settings: { stripe: { ...base, blocking_requirements: ['identity.address'] } } } }
    expect(resolveStripeReadiness(blocked)).toMatchObject({ ready: false, reason: 'SELLER_STRIPE_REQUIREMENTS_DUE' })
  })

  it('persists and reconstructs the discriminant, account, IDs and currency', () => {
    const plan = planStripeMarketStrategy({ seller: usSeller, cart_currency: 'usd' })
    if (!plan.ok) throw new Error('expected plan')
    const data = buildStripePaymentContext(plan, { stripe_session_id: 'cs_1', stripe_payment_intent: 'pi_1', stripe_charge_id: 'ch_1' })
    expect(readStripePaymentContext(data as unknown as Record<string, unknown>)).toEqual(data)
    expect(stripeRequestOptions(data)).toEqual({ stripeAccount: 'acct_us' })
  })

  it('uses account context and never reverse_transfer for a US direct refund', () => {
    const context = readStripePaymentContext({ stripe_market: 'us', stripe_strategy: 'direct_charge', stripe_account_id: 'acct_us', stripe_session_id: 'cs', stripe_payment_intent: 'pi', stripe_charge_id: 'ch', stripe_currency: 'usd' })!
    expect(stripeRefundParams(context, 1250)).toEqual({ payment_intent: 'pi', charge: undefined, amount: 1250 })
    expect(stripeRequestOptions(context)).toEqual({ stripeAccount: 'acct_us' })
  })

  it('keeps reverse_transfer for MX destination-charge refunds', () => {
    const context = readStripePaymentContext({ stripe_market: 'mx', stripe_strategy: 'destination_charge', stripe_account_id: 'acct_mx', stripe_session_id: 'cs', stripe_payment_intent: 'pi', stripe_charge_id: 'ch', stripe_currency: 'mxn' })!
    expect(stripeRefundParams(context)).toMatchObject({ payment_intent: 'pi', reverse_transfer: true })
    expect(stripeRequestOptions(context)).toBeUndefined()
  })

  it('verifies provider webhooks against direct account context', () => {
    const session = { metadata: { stripe_strategy: 'direct_charge', stripe_account_id: 'acct_us' } } as any
    expect(webhookMatchesPaymentContext({ account: 'acct_us' } as any, session)).toBe(true)
    expect(webhookMatchesPaymentContext({ account: 'acct_attacker' } as any, session)).toBe(false)
    expect(webhookMatchesPaymentContext({} as any, { metadata: { stripe_strategy: 'destination_charge', stripe_account_id: 'acct_mx' } } as any)).toBe(true)
  })
})

describe('checkout refusal — the MX wire contract is frozen', () => {
  // BuyButton.tsx and CheckoutPayButton.tsx both branch on the LITERAL string
  // 'SELLER_NOT_CONNECTED'. If a richer per-reason code ever reaches an MX buyer,
  // they lose the friendly copy and see a raw error instead. That is an MX
  // regression, which this epic forbids outright.
  const MX_MESSAGE = 'Este vendedor aún no ha activado los pagos. Contacta al vendedor directamente.'

  it.each([
    ['no stripe account', { metadata: { operating_market: 'mx', settings: { stripe: {} } } }],
    ['charges disabled', { metadata: { operating_market: 'mx', settings: { stripe: { account_id: 'acct_mx', charges_enabled: false } } } }],
    ['explicitly disabled', { metadata: { operating_market: 'mx', settings: { stripe: { account_id: 'acct_mx', enabled: false } } } }],
  ])('MX refusal for %s keeps 422 + SELLER_NOT_CONNECTED + the Spanish copy', (_label, seller) => {
    const plan = planStripeMarketStrategy({ seller, cart_currency: 'mxn' })
    expect(plan.ok).toBe(false)
    expect(checkoutRefusalResponse(plan as never)).toEqual({
      status: 422,
      body: { message: MX_MESSAGE, code: 'SELLER_NOT_CONNECTED' },
    })
  })

  it('an MX currency mismatch also refuses on the frozen contract', () => {
    const plan = planStripeMarketStrategy({ seller: mxSeller, cart_currency: 'usd' })
    expect(checkoutRefusalResponse(plan as never).body.code).toBe('SELLER_NOT_CONNECTED')
  })

  it('an unreadable market falls back to the frozen MX refusal rather than asserting a market', () => {
    const plan = planStripeMarketStrategy({ seller: { metadata: { operating_market: 'zz' } }, cart_currency: 'mxn' })
    expect(plan).toMatchObject({ ok: false, market: null })
    expect(checkoutRefusalResponse(plan as never).body.code).toBe('SELLER_NOT_CONNECTED')
  })

  it('US returns the SPECIFIC reason — new surface, no legacy consumer', () => {
    const notReady = { metadata: { operating_market: 'us', settings: { stripe: {
      account_id: 'acct_us', api_generation: 'v2', account_country: 'us',
      merchant_configuration: 'active', card_payments_status: 'inactive', payouts_status: 'active',
    } } } }
    const plan = planStripeMarketStrategy({ seller: notReady, cart_currency: 'usd' })
    const refusal = checkoutRefusalResponse(plan as never)
    expect(refusal.body.code).toBe('SELLER_STRIPE_CAPABILITY_INACTIVE')
    expect(refusal.body.message).not.toBe(MX_MESSAGE)
  })

  it('a ready US seller is not refused at all', () => {
    expect(planStripeMarketStrategy({ seller: usSeller, cart_currency: 'usd' }).ok).toBe(true)
  })
})

describe('US readiness matches the REAL Accounts v2 shape', () => {
  // Measured 2026-08-11 against a live test account: configuration.merchant exposes
  // only card_payments with a status, and configuration.recipient is empty. A gate
  // requiring payouts_status would be unsatisfiable — US could never transact.
  const base = {
    account_id: 'acct_us', api_generation: 'v2', account_country: 'us',
    merchant_configuration: 'active', card_payments_status: 'active',
  }
  const sellerWith = (stripe: Record<string, unknown>) => ({
    metadata: { operating_market: 'us', settings: { stripe } },
  })

  it('is READY with no payouts_status at all — the real account never reports one', () => {
    expect(resolveStripeReadiness(sellerWith(base))).toMatchObject({ ready: true, reason: null })
  })

  it('is ready when payouts_status is explicitly active', () => {
    expect(resolveStripeReadiness(sellerWith({ ...base, payouts_status: 'active' })).ready).toBe(true)
  })

  it('is NOT ready when payouts_status is explicitly non-active (unknown != inactive)', () => {
    expect(resolveStripeReadiness(sellerWith({ ...base, payouts_status: 'restricted' }))).toMatchObject({
      ready: false, reason: 'SELLER_STRIPE_PAYOUTS_INACTIVE',
    })
  })

  it('is NOT ready when card_payments is not active', () => {
    expect(resolveStripeReadiness(sellerWith({ ...base, card_payments_status: 'restricted' }))).toMatchObject({
      ready: false, reason: 'SELLER_STRIPE_CAPABILITY_INACTIVE',
    })
  })

  it('is NOT ready with blocking requirements outstanding', () => {
    expect(resolveStripeReadiness(sellerWith({ ...base, blocking_requirements: ['individual.id_number'] }))).toMatchObject({
      ready: false, reason: 'SELLER_STRIPE_REQUIREMENTS_DUE',
    })
  })

  it('a real-shaped US seller plans a direct charge end to end', () => {
    const plan = planStripeMarketStrategy({ seller: sellerWith(base), cart_currency: 'usd' })
    expect(plan).toMatchObject({ ok: true, strategy: 'direct_charge', request_options: { stripeAccount: 'acct_us' } })
  })
})

describe('review findings — status codes and the Region cross-check', () => {
  const notReady = (stripe: Record<string, unknown>) => ({
    metadata: { operating_market: 'us', settings: { stripe } },
  })
  const ready = {
    account_id: 'acct_us', api_generation: 'v2', account_country: 'us',
    merchant_configuration: 'active', card_payments_status: 'active',
  }

  // A known seller state is never a 503: that tells the caller "retry, this is
  // temporary" about something that will never change on its own, and buries real
  // outages in seller-configuration noise.
  it.each([
    ['no account', {}],
    ['capability restricted', { ...ready, card_payments_status: 'restricted' }],
    ['requirements due', { ...ready, blocking_requirements: ['configuration.merchant.mcc'] }],
    ['legacy generation', { ...ready, api_generation: 'v1' }],
    ['country mismatch', { ...ready, account_country: 'mx' }],
    ['merchant inactive', { ...ready, merchant_configuration: 'inactive' }],
    ['payouts explicitly inactive', { ...ready, payouts_status: 'restricted' }],
  ])('%s refuses with 422, never 503', (_label, stripe) => {
    const plan = planStripeMarketStrategy({ seller: notReady(stripe), cart_currency: 'usd' })
    expect(plan).toMatchObject({ ok: false, status: 422 })
  })

  it('the Region cross-check fires when both ids are supplied', () => {
    expect(planStripeMarketStrategy({
      seller: notReady(ready), cart_currency: 'usd',
      cart_region_id: 'reg_wrong', expected_region_id: 'reg_us',
    })).toMatchObject({ ok: false, code: 'CHECKOUT_REGION_MISMATCH' })
  })

  it('passes when the cart Region matches the market Region', () => {
    expect(planStripeMarketStrategy({
      seller: notReady(ready), cart_currency: 'usd',
      cart_region_id: 'reg_us', expected_region_id: 'reg_us',
    }).ok).toBe(true)
  })

  // An unconfigured environment must not refuse every checkout: with no expected
  // Region there is nothing to contradict, so the guard declines to assert one.
  it('declines to assert a mismatch when the market has no configured Region', () => {
    expect(planStripeMarketStrategy({
      seller: notReady(ready), cart_currency: 'usd',
      cart_region_id: 'reg_anything', expected_region_id: null,
    }).ok).toBe(true)
  })
})
