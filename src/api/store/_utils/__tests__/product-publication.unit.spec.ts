import { UnknownMarketError } from '../../../../lib/markets'
import { planProductPublication } from '../product-publication'

/**
 * Publication intent at the seller-product create call site (build contract item 4,
 * stories 1.2 + 1.3). Pure over an injected env — no container, no workflow.
 *
 * The two rules under test are the ones a cross-review found missing in the first
 * draft: the market comes from the SELLER (not a platform default), and there is no
 * channel-less "owned shop only" product.
 */

const MX_CHANNEL = 'sc_01KSK1J0V81P4EPY9G0JAPX353'
/** The live MX operating channel (owned-shop-operating-channel epic, S1.3). */
const MX_OPERATING = 'sc_01KYWNQ0C0PFFM0K0V2EMC24AP'
const PROD_ENV = {
  MEDUSA_SALES_CHANNEL_ID: MX_CHANNEL,
  MEDUSA_MX_OPERATING_CHANNEL_ID: MX_OPERATING,
}

describe('planProductPublication — the market comes from the SELLER', () => {
  it('an mx seller with no stated market publishes to the MX marketplace channel', () => {
    expect(planProductPublication({ sellerMarket: 'mx' }, PROD_ENV))
      .toEqual({
        status: 'channels',
        market: 'mx',
        operating_channel_id: MX_OPERATING,
        marketplace_channel_id: MX_CHANNEL,
        channel_ids: [MX_OPERATING, MX_CHANNEL],
      })
  })

  it('stating your own market explicitly is the same thing', () => {
    expect(planProductPublication({ requested: 'mx', sellerMarket: 'mx' }, PROD_ENV))
      .toEqual({
        status: 'channels',
        market: 'mx',
        operating_channel_id: MX_OPERATING,
        marketplace_channel_id: MX_CHANNEL,
        channel_ids: [MX_OPERATING, MX_CHANNEL],
      })
  })

  it('a US seller is REFUSED and gets NO Mexico channel — not even by default', () => {
    // The bug this replaces: the default intent was DEFAULT_MARKET ('mx') regardless
    // of who the seller was, so a US shop silently published into Mexico and
    // inherited Mexico's Stripe/shipping rails.
    const plan = planProductPublication({ sellerMarket: 'us' }, PROD_ENV)
    expect(plan.status).toBe('refused')
    if (plan.status !== 'refused') throw new Error('unreachable')
    expect(plan.market).toBe('us')
    expect(plan.message).toMatch(/no está abierto/)
    expect(JSON.stringify(plan)).not.toContain(MX_CHANNEL)
  })

  it('a US seller cannot bypass the refusal by NAMING mx in the request', () => {
    // Without the cross-market clause, the guard above would be one request-body
    // field away from being useless.
    const plan = planProductPublication({ requested: 'mx', sellerMarket: 'us' }, PROD_ENV)
    expect(plan.status).toBe('refused')
    if (plan.status !== 'refused') throw new Error('unreachable')
    expect(plan.message).toMatch(/específica de cada país/)
    expect(JSON.stringify(plan)).not.toContain(MX_CHANNEL)
  })

  it('an mx seller cannot publish into another market either — publication is per-country', () => {
    const plan = planProductPublication({ requested: 'us', sellerMarket: 'mx' }, PROD_ENV)
    expect(plan.status).toBe('refused')
  })

  it('an unsupported market throws — including a locale', () => {
    expect(() => planProductPublication({ requested: 'ca' as never, sellerMarket: 'mx' }, PROD_ENV))
      .toThrow(UnknownMarketError)
    expect(() => planProductPublication({ requested: 'es-MX' as never, sellerMarket: 'mx' }, PROD_ENV))
      .toThrow(/LOCALE/)
    expect(() => planProductPublication({ sellerMarket: 'ca' as never }, PROD_ENV))
      .toThrow(UnknownMarketError)
  })
})

describe('planProductPublication — "owned shop only" is not a shippable capability', () => {
  it('publish_to_market: null is REFUSED, loudly', () => {
    // A channel-less product renders on the shop and cannot be bought: it 404s on the
    // channel-scoped /store/products endpoint and its checkout fails "Product not
    // found". Buying it needs a second per-market OPERATING channel, which is a
    // follow-up epic (new prod channel + publishable-key change + full backfill).
    // Refused rather than ignored, so a client written against the earlier draft gets
    // an error instead of silently receiving marketplace publication.
    const plan = planProductPublication({ requested: null, sellerMarket: 'mx' }, PROD_ENV)
    expect(plan.status).toBe('refused')
    if (plan.status !== 'refused') throw new Error('unreachable')
    expect(plan.message).toMatch(/no se puede comprar/)
  })

  it('no outcome ever produces a product with no channel', () => {
    for (const env of [PROD_ENV, {}, { MEDUSA_SALES_CHANNEL_ID: MX_CHANNEL }]) {
      const plan = planProductPublication({ sellerMarket: 'mx' }, env)
      if (plan.status === 'channels') expect(plan.channel_ids.length).toBeGreaterThan(0)
      else expect(plan.http_status).toBeGreaterThanOrEqual(400)
    }
  })
})

describe('planProductPublication — active-market configuration fails closed', () => {
  it('mx with no marketplace channel refuses instead of adopting the Store default', () => {
    const plan = planProductPublication({ sellerMarket: 'mx' }, {})
    expect(plan.status).toBe('refused')
    if (plan.status !== 'refused') throw new Error('unreachable')
    expect(plan.http_status).toBe(503)
    expect(plan.message).toMatch(/MEDUSA_SALES_CHANNEL_ID/)
    expect(JSON.stringify(plan)).not.toContain('store_default')
  })

  it('a refused market does NOT reach the store-default fallback', () => {
    expect(planProductPublication({ sellerMarket: 'us' }, {}).status).toBe('refused')
  })
})


/**
 * D2 — the operating channel is a strict SUPERSET of the marketplace channel, and
 * that superset property is the entire reason the storefront's publishable key can
 * hold a single channel (D3). These are the specs for the half of that rule this file
 * owns: what a NEW product joins.
 */
describe('planProductPublication — D2: every product joins the OPERATING channel', () => {
  it('attaches BOTH channels, operating first', () => {
    const plan = planProductPublication({ sellerMarket: 'mx' }, PROD_ENV)
    if (plan.status !== 'channels') throw new Error('unreachable')
    expect(plan.operating_channel_id).toBe(MX_OPERATING)
    expect(plan.marketplace_channel_id).toBe(MX_CHANNEL)
    expect([...plan.channel_ids]).toEqual([MX_OPERATING, MX_CHANNEL])
  })

  it('REFUSES when the operating channel is unconfigured — never marketplace-only', () => {
    // This is the failure the epic exists to prevent: a product created into the
    // marketplace channel alone looks perfectly healthy today and becomes unbuyable
    // the instant the publishable key moves (D3).
    const plan = planProductPublication(
      { sellerMarket: 'mx' },
      { MEDUSA_SALES_CHANNEL_ID: MX_CHANNEL },
    )
    expect(plan.status).toBe('refused')
    if (plan.status !== 'refused') throw new Error('unreachable')
    expect(plan.http_status).toBe(503)
    expect(plan.message).toMatch(/MEDUSA_MX_OPERATING_CHANNEL_ID/)
    // The actionable half: a builder reading this must know what to set.
    expect(plan.message).toMatch(/canal operativo/)
  })

  it('a misconfiguration pointing BOTH env vars at one channel yields ONE link, not two', () => {
    // Duplicate and dangling link rows are the entire history of this repo's channel
    // incidents. Never make more of them.
    const plan = planProductPublication(
      { sellerMarket: 'mx' },
      { MEDUSA_SALES_CHANNEL_ID: MX_CHANNEL, MEDUSA_MX_OPERATING_CHANNEL_ID: MX_CHANNEL },
    )
    if (plan.status !== 'channels') throw new Error('unreachable')
    expect([...plan.channel_ids]).toEqual([MX_CHANNEL])
  })

  it('a US seller gets NO operating channel either — us is structurally fail-closed', () => {
    const plan = planProductPublication({ sellerMarket: 'us' }, PROD_ENV)
    expect(plan.status).toBe('refused')
    expect(JSON.stringify(plan)).not.toContain(MX_OPERATING)
  })

  it('an unknown seller market throws rather than defaulting to MX', () => {
    // The parent epic's write-default rule: a shop whose market we cannot classify is
    // never adopted into Mexico's commerce rails.
    expect(() => planProductPublication({ sellerMarket: 'zz' as never }, PROD_ENV))
      .toThrow(UnknownMarketError)
  })
})
