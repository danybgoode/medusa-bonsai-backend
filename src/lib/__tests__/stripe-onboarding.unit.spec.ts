import {
  mergeStripeSettings,
  planStripeOnboarding,
  usAccountCreateParams,
} from '../stripe-onboarding'

const usSeller = (stripe: Record<string, unknown> = {}) => ({
  metadata: { operating_market: 'us', settings: { stripe } },
})

describe('planStripeOnboarding', () => {
  it('creates an account for a US shop that has none', () => {
    expect(planStripeOnboarding(usSeller())).toEqual({ action: 'create', market: 'us' })
  })

  it('reuses the account already on the seller — never one supplied by a caller', () => {
    expect(planStripeOnboarding(usSeller({ account_id: 'acct_existing', api_generation: 'v2' })))
      .toEqual({ action: 'reuse', market: 'us', account_id: 'acct_existing' })
  })

  // MX must keep its shipped v1 Express flow. Creating a v2 account beside a working
  // v1 one would leave a shop with two live payout destinations.
  it('refuses an MX shop rather than quietly giving it a second account', () => {
    const mx = { metadata: { operating_market: 'mx', settings: { stripe: { account_id: 'acct_mx' } } } }
    expect(planStripeOnboarding(mx)).toMatchObject({
      action: 'refuse', code: 'STRIPE_ONBOARDING_MARKET_UNSUPPORTED',
    })
  })

  it('refuses a US shop carrying a legacy v1 account instead of onboarding over it', () => {
    expect(planStripeOnboarding(usSeller({ account_id: 'acct_old', api_generation: 'v1' }))).toMatchObject({
      action: 'refuse', code: 'STRIPE_ACCOUNT_GENERATION_CONFLICT',
    })
  })

  it('refuses an unreadable market rather than assuming US', () => {
    expect(planStripeOnboarding({ metadata: { operating_market: 'zz' } })).toMatchObject({
      action: 'refuse', code: 'SELLER_MARKET_INVALID',
    })
    expect(planStripeOnboarding(null)).toMatchObject({ action: 'refuse' })
  })

  it('treats an account with no recorded generation as v2-ready to reuse', () => {
    // Accounts this epic creates are always v2; absence means "not yet synced",
    // not "legacy". Refusing here would strand a shop mid-onboarding.
    expect(planStripeOnboarding(usSeller({ account_id: 'acct_new' }))).toMatchObject({ action: 'reuse' })
  })
})

describe('usAccountCreateParams — the shape the live API accepts', () => {
  const params = usAccountCreateParams('seller@example.com', 'Test Shop')

  it('uses locales (plural, array) — the API rejects `locale`', () => {
    expect(params.defaults.locales).toEqual(['en-US'])
    expect(params.defaults).not.toHaveProperty('locale')
  })

  it('is a US merchant with USD defaults and Stripe-collected fees and losses', () => {
    expect(params.identity.country).toBe('us')
    expect(params.defaults.currency).toBe('usd')
    expect(params.defaults.responsibilities).toEqual({ fees_collector: 'stripe', losses_collector: 'stripe' })
    expect(params.dashboard).toBe('full')
  })

  it('requests ONLY card_payments — an unrequested capability adds requirements for nothing', () => {
    expect(Object.keys(params.configuration.merchant.capabilities)).toEqual(['card_payments'])
  })
})

describe('mergeStripeSettings', () => {
  it('overlays the projection without blanking sibling settings', () => {
    const merged = mergeStripeSettings(
      { support: { on: true }, stripe: { enabled: true, onboarding_complete: false, account_id: 'acct_a' } },
      { account_id: 'acct_a', card_payments_status: 'active', api_generation: 'v2' },
    )
    expect(merged).toEqual({
      support: { on: true },
      stripe: {
        enabled: true, onboarding_complete: false,
        account_id: 'acct_a', card_payments_status: 'active', api_generation: 'v2',
      },
    })
  })

  it('does not lose MX charges_enabled living beside a US projection key', () => {
    const merged = mergeStripeSettings({ stripe: { charges_enabled: true } }, { card_payments_status: 'active' })
    expect((merged.stripe as Record<string, unknown>).charges_enabled).toBe(true)
  })

  it('tolerates settings with no stripe block at all', () => {
    expect(mergeStripeSettings({}, { account_id: 'acct_b' })).toEqual({ stripe: { account_id: 'acct_b' } })
  })
})
