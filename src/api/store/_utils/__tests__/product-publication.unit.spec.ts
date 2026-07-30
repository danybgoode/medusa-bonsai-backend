import { UnknownMarketError } from '../../../../lib/markets'
import {
  planProductPublication,
  resolveRequiredPublicationChannel,
} from '../product-publication'

/**
 * Publication intent at the seller-product create call site (build contract item 4,
 * stories 1.2 + 1.3). Pure over an injected env — no container, no workflow.
 *
 * The two rules under test are the ones a cross-review found missing in the first
 * draft: the market comes from the SELLER (not a platform default), and there is no
 * channel-less "owned shop only" product.
 */

const MX_CHANNEL = 'sc_01KSK1J0V81P4EPY9G0JAPX353'
const PROD_ENV = { MEDUSA_SALES_CHANNEL_ID: MX_CHANNEL }

describe('planProductPublication — the market comes from the SELLER', () => {
  it('an mx seller with no stated market publishes to the MX marketplace channel', () => {
    expect(planProductPublication({ sellerMarket: 'mx' }, PROD_ENV))
      .toEqual({ status: 'channel', market: 'mx', channel_id: MX_CHANNEL })
  })

  it('stating your own market explicitly is the same thing', () => {
    expect(planProductPublication({ requested: 'mx', sellerMarket: 'mx' }, PROD_ENV))
      .toEqual({ status: 'channel', market: 'mx', channel_id: MX_CHANNEL })
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
    // Every non-refused status must name a channel or send the caller to the store
    // default. "Create it with nothing" is not in the type any more.
    for (const env of [PROD_ENV, {}]) {
      const plan = planProductPublication({ sellerMarket: 'mx' }, env)
      expect(['channel', 'store_default']).toContain(plan.status)
    }
  })
})

describe('planProductPublication — the legacy store-default fallback survives', () => {
  it('mx with no env var falls back to the store default, as before', () => {
    const plan = planProductPublication({ sellerMarket: 'mx' }, {})
    expect(plan.status).toBe('store_default')
    if (plan.status !== 'store_default') throw new Error('unreachable')
    expect(plan.reason).toMatch(/MEDUSA_SALES_CHANNEL_ID/)
  })

  it('a refused market does NOT reach the store-default fallback', () => {
    expect(planProductPublication({ sellerMarket: 'us' }, {}).status).toBe('refused')
  })
})

describe('resolveRequiredPublicationChannel — the I/O shell cannot create channel-less products', () => {
  it('uses an already-resolved market channel without consulting the store fallback', async () => {
    const readDefault = jest.fn(async () => 'sc_default')
    await expect(resolveRequiredPublicationChannel(
      { status: 'channel', market: 'mx', channel_id: MX_CHANNEL },
      readDefault,
    )).resolves.toEqual({ ok: true, channel_id: MX_CHANNEL })
    expect(readDefault).not.toHaveBeenCalled()
  })

  it.each([undefined, null, '', '   ', 42])(
    'refuses a missing or invalid store default (%p) before product creation',
    async (value) => {
      const result = await resolveRequiredPublicationChannel(
        { status: 'store_default', market: 'mx', reason: 'env unset' },
        async () => value,
      )
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.message).toMatch(/no tiene un canal de venta predeterminado/)
      expect(result.message).toMatch(/no fue creado/)
    },
  )

  it('refuses a throwing store lookup before product creation', async () => {
    const result = await resolveRequiredPublicationChannel(
      { status: 'store_default', market: 'mx', reason: 'env unset' },
      async () => { throw new Error('store database unavailable') },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toMatch(/No se pudo resolver/)
    expect(result.message).toMatch(/no fue creado/)
  })

  it('trims and returns a valid store default id', async () => {
    await expect(resolveRequiredPublicationChannel(
      { status: 'store_default', market: 'mx', reason: 'env unset' },
      async () => '  sc_default  ',
    )).resolves.toEqual({ ok: true, channel_id: 'sc_default' })
  })
})
