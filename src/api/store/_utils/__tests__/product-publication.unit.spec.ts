import { UnknownMarketError } from '../../../../lib/markets'
import { planPublicationChannel, resolvePublicationIntent } from '../product-publication'

/**
 * Publication intent at the seller-product create call site (build contract item 4,
 * story 1.3). Pure over an injected env — no container, no workflow.
 */

const MX_CHANNEL = 'sc_01KSK1J0V81P4EPY9G0JAPX353'
const PROD_ENV = { MEDUSA_SALES_CHANNEL_ID: MX_CHANNEL }

describe('resolvePublicationIntent — "did not say" and "said no" are different', () => {
  it('omitted ⇒ marketplace/mx (byte-identical to every existing caller)', () => {
    expect(resolvePublicationIntent(undefined)).toEqual({ kind: 'marketplace', market: 'mx' })
  })

  it('null ⇒ owned-shop only, an explicit choice', () => {
    expect(resolvePublicationIntent(null)).toEqual({ kind: 'owned_shop_only' })
  })

  it('an explicit market is honoured', () => {
    expect(resolvePublicationIntent('us')).toEqual({ kind: 'marketplace', market: 'us' })
  })

  it('an unsupported value throws — including a locale', () => {
    expect(() => resolvePublicationIntent('ca' as never)).toThrow(UnknownMarketError)
    expect(() => resolvePublicationIntent('es-MX' as never)).toThrow(/LOCALE/)
  })
})

describe('planPublicationChannel', () => {
  it('mx resolves to the MX marketplace channel', () => {
    expect(planPublicationChannel({ kind: 'marketplace', market: 'mx' }, PROD_ENV))
      .toEqual({ status: 'channel', market: 'mx', channel_id: MX_CHANNEL })
  })

  it('owned-shop only attaches NO channel', () => {
    const plan = planPublicationChannel({ kind: 'owned_shop_only' }, PROD_ENV)
    expect(plan.status).toBe('none')
    expect(JSON.stringify(plan)).not.toContain(MX_CHANNEL)
  })

  it('a market whose marketplace is not open is REFUSED — not downgraded to Mexico', () => {
    const plan = planPublicationChannel({ kind: 'marketplace', market: 'us' }, PROD_ENV)
    expect(plan.status).toBe('refused')
    if (plan.status !== 'refused') throw new Error('unreachable')
    expect(plan.market).toBe('us')
    // The load-bearing assertion: no Mexico channel anywhere in the outcome. A
    // fallback here would publish a US shop into the Mexico marketplace and hand it
    // Mexico's Stripe/shipping rails.
    expect(JSON.stringify(plan)).not.toContain(MX_CHANNEL)
  })

  it('mx with no env var falls back to the store default — the pre-existing behaviour', () => {
    // A product in NO channel 404s on the channel-scoped /store/products endpoint and
    // its checkout fails with "Product not found". That is why this fallback exists,
    // and it is deliberately preserved for the default market.
    const plan = planPublicationChannel({ kind: 'marketplace', market: 'mx' }, {})
    expect(plan.status).toBe('store_default')
    if (plan.status !== 'store_default') throw new Error('unreachable')
    expect(plan.reason).toMatch(/MEDUSA_SALES_CHANNEL_ID/)
  })

  it('the us refusal does NOT fall back to the store default either', () => {
    expect(planPublicationChannel({ kind: 'marketplace', market: 'us' }, {}).status).toBe('refused')
  })
})
