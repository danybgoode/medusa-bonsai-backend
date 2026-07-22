import { normalizeMedusaOrder } from '../route'

/**
 * `payment_captured` — the honest "did the money actually land?" answer
 * (miyagisanchezcommerce#298, fresh-reviewer finding).
 *
 * The bug this guards against is subtle and was live: `status` is NOT an assertion of
 * capture. It initialises to 'paid' and is only demoted for cancel/refund/return or an
 * uncaptured MANUAL method — so an automatic order sitting at `payment_status:
 * 'authorized'` normalises to 'paid'. A consumer reading `status === 'paid'` as "we have
 * the money" is reading a fall-through default.
 *
 * That is harmless for the seller order list this route was written for, and NOT harmless
 * for the merchant-lifecycle projection, whose `first_sale` milestone is write-once and
 * unwithdrawable. The FIRST test below is the load-bearing one: it fails against the
 * pre-fix behaviour of inferring capture from `status`.
 */

// Minimal order in the shape `normalizeMedusaOrder` reads. Everything it does not touch
// is omitted deliberately — a fixture that mirrors a real order would hide which fields
// actually drive the result.
function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order_test',
    status: 'pending',
    currency_code: 'mxn',
    total: 10_000,
    items: [],
    metadata: {},
    ...overrides,
  }
}

const norm = (o: Record<string, unknown>) =>
  normalizeMedusaOrder(o, 'seller_1', 'Tienda de Prueba') as unknown as {
    status: string
    payment_status: string | null
    payment_captured: boolean
  }

describe('normalizeMedusaOrder · payment_captured', () => {
  it('an AUTHORIZED card order reports status "paid" but is NOT captured', () => {
    // The whole reason this field exists. If these two ever agree, the fall-through
    // default has been mistaken for a capture assertion again.
    const r = norm(order({ payment_status: 'authorized', metadata: { payment_method: 'card' } }))
    expect(r.status).toBe('paid')
    expect(r.payment_captured).toBe(false)
    expect(r.payment_status).toBe('authorized')
  })

  it('a CAPTURED card order is captured', () => {
    const r = norm(order({ payment_status: 'captured', metadata: { payment_method: 'card' } }))
    expect(r.payment_captured).toBe(true)
  })

  it('a PARTIALLY captured order counts as captured — money did land', () => {
    const r = norm(order({ payment_status: 'partially_captured', metadata: { payment_method: 'card' } }))
    expect(r.payment_captured).toBe(true)
  })

  it('a manual (SPEI) order the seller has NOT confirmed is not captured', () => {
    const r = norm(order({ payment_status: 'authorized', metadata: { payment_method: 'spei' } }))
    expect(r.status).toBe('pending_payment')
    expect(r.payment_captured).toBe(false)
  })

  it('a manual order the seller HAS confirmed is captured — receipt is how manual money lands', () => {
    const r = norm(
      order({
        payment_status: 'authorized',
        metadata: { payment_method: 'spei', payment_received: true },
      }),
    )
    expect(r.payment_captured).toBe(true)
  })

  it('an order with no payment_status at all is not captured (absence is never capture)', () => {
    const r = norm(order({ metadata: { payment_method: 'card' } }))
    expect(r.payment_status).toBeNull()
    expect(r.payment_captured).toBe(false)
  })

  it('a REFUNDED order is not captured — Medusa has moved payment_status off "captured"', () => {
    // Worth pinning because it is easy to assume otherwise: the money DID land once, but
    // `payment_status` is now 'refunded', so `isCaptured` is false. Consumers get the same
    // answer from two directions here (`status` is also 'refunded'), which is the safe
    // alignment for a write-once milestone — neither path grants `first_sale`.
    const r = norm(
      order({ payment_status: 'refunded', metadata: { payment_method: 'card', payment_received: true } }),
    )
    expect(r.status).toBe('refunded')
    expect(r.payment_captured).toBe(false)
  })
})
