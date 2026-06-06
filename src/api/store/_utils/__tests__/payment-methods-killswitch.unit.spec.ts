import { resolveSellerPaymentMethods } from '../payment-methods'

/**
 * Feature flags & kill-switches · Sprint 2 (backend enforcement).
 * The `checkout.stripe_enabled` kill-switch, applied at the single source of
 * truth for the payment catalog. Pure function — no Flagsmith, no DB. The flag
 * *value* is resolved by src/lib/flags.ts (fail-open); this proves the filter.
 */

// A seller with Stripe AND SPEI configured (so we can prove only Stripe drops).
const seller = {
  metadata: {
    settings: {
      stripe: { account_id: 'acct_test', charges_enabled: true },
      checkout: { bank_transfer: { clabe: '012345678901234567' } }, // 18 digits → SPEI on
    },
  },
}

describe('resolveSellerPaymentMethods · checkout.stripe_enabled kill-switch', () => {
  it('lists Stripe by default (no opts → fail-open on)', () => {
    const { methods } = resolveSellerPaymentMethods(seller)
    expect(methods.map(m => m.id)).toContain('stripe')
  })

  it('lists Stripe when the flag is ON', () => {
    const { methods } = resolveSellerPaymentMethods(seller, undefined, { stripeEnabled: true })
    expect(methods.map(m => m.id)).toContain('stripe')
  })

  it('drops ONLY Stripe when the flag is OFF (other rails untouched)', () => {
    const { methods } = resolveSellerPaymentMethods(seller, undefined, { stripeEnabled: false })
    const ids = methods.map(m => m.id)
    expect(ids).not.toContain('stripe')
    expect(ids).toContain('spei') // SPEI still offered
  })

  it('falls the default off Stripe when it is killed', () => {
    const stripeOnly = { metadata: { settings: { stripe: { account_id: 'acct_x', charges_enabled: true } } } }
    expect(resolveSellerPaymentMethods(stripeOnly).default).toBe('stripe')
    const killed = resolveSellerPaymentMethods(stripeOnly, undefined, { stripeEnabled: false })
    expect(killed.methods).toHaveLength(0)
    expect(killed.default).toBeNull()
  })
})
