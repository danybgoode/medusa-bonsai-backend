import { UnknownMarketError } from '../../../../lib/markets'
import { planProductPublication, planPublicationChange } from '../product-publication'

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
const US_MARKETPLACE = 'sc_01KZQA8RYRWJ9NDE7AVREQQ646'
const US_OPERATING = 'sc_01KZQA8RYSWA3GYNWESQN8Z9HW'
const TWO_MARKET_ENV = {
  ...PROD_ENV,
  MEDUSA_US_MARKETPLACE_CHANNEL_ID: US_MARKETPLACE,
  MEDUSA_US_OPERATING_CHANNEL_ID: US_OPERATING,
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

  it('a US seller publishes to BOTH configured US channels and gets NO Mexico channel', () => {
    const plan = planProductPublication({ sellerMarket: 'us' }, TWO_MARKET_ENV)
    expect(plan).toEqual({
      status: 'channels',
      market: 'us',
      operating_channel_id: US_OPERATING,
      marketplace_channel_id: US_MARKETPLACE,
      channel_ids: [US_OPERATING, US_MARKETPLACE],
    })
    expect(JSON.stringify(plan)).not.toContain(MX_CHANNEL)
    expect(JSON.stringify(plan)).not.toContain(MX_OPERATING)
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

describe('planProductPublication — "owned shop only" (S3.1), gated on catalog.owned_shop_only_enabled', () => {
  it('publish_to_market: null is REFUSED while the flag is OFF (default, and omitted)', () => {
    // Flag OFF is BOTH the platform default and what an older caller gets by not
    // passing `ownedShopOnlyEnabled` at all — the pre-Sprint-3 contract is preserved
    // byte-for-byte until an operator deliberately turns this on.
    for (const input of [
      { requested: null, sellerMarket: 'mx' } as const,
      { requested: null, sellerMarket: 'mx', ownedShopOnlyEnabled: false } as const,
    ]) {
      const plan = planProductPublication(input, PROD_ENV)
      expect(plan.status).toBe('refused')
      if (plan.status !== 'refused') throw new Error('unreachable')
      expect(plan.http_status).toBe(422)
      expect(JSON.stringify(plan)).not.toContain(MX_CHANNEL)
      expect(JSON.stringify(plan)).not.toContain(MX_OPERATING)
    }
  })

  it('publish_to_market: null is ACCEPTED once the flag is ON — operating channel only', () => {
    const plan = planProductPublication(
      { requested: null, sellerMarket: 'mx', ownedShopOnlyEnabled: true },
      PROD_ENV,
    )
    expect(plan.status).toBe('channels')
    if (plan.status !== 'channels') throw new Error('unreachable')
    expect(plan.operating_channel_id).toBe(MX_OPERATING)
    // The whole point: no marketplace channel, and the channel set is the operating
    // id ALONE — never marketplace-only, never empty.
    expect(plan.marketplace_channel_id).toBeNull()
    expect([...plan.channel_ids]).toEqual([MX_OPERATING])
  })

  it('flag ON still refuses when the operating channel itself is unconfigured — never falls back to marketplace-only', () => {
    const plan = planProductPublication(
      { requested: null, sellerMarket: 'mx', ownedShopOnlyEnabled: true },
      { MEDUSA_SALES_CHANNEL_ID: MX_CHANNEL }, // operating var missing
    )
    expect(plan.status).toBe('refused')
    if (plan.status !== 'refused') throw new Error('unreachable')
    expect(plan.http_status).toBe(503)
    expect(JSON.stringify(plan)).not.toContain(MX_CHANNEL)
  })

  it('a US owned-shop-only create uses the US operating channel when enabled', () => {
    expect(planProductPublication({
      requested: null,
      sellerMarket: 'us',
      ownedShopOnlyEnabled: true,
    }, TWO_MARKET_ENV)).toEqual({
      status: 'channels',
      market: 'us',
      operating_channel_id: US_OPERATING,
      marketplace_channel_id: null,
      channel_ids: [US_OPERATING],
    })
  })
})

/**
 * ── EXHAUSTIVE, NOT BY EXAMPLE ────────────────────────────────────────────────────
 * Story 3.1's acceptance: "the unsellable state stays unreachable: there is no value
 * of `publish_to_market` that produces a product in zero channels. Assert it
 * exhaustively over the input domain, not by example."
 *
 * The discrete input domain this function reads is small enough to enumerate in
 * full: `requested` ∈ {undefined, null, 'mx', 'us'} (any other string THROWS via
 * `requireMarket` before reaching a channel decision — a different, already-covered
 * code path, not a silent zero-channel outcome), `sellerMarket` ∈ {'mx', 'us'}
 * (`MARKET_CODES`, the full registry), `ownedShopOnlyEnabled` ∈ {true, false}. That
 * is 4 × 2 × 2 = 16 combinations — EVERY one of them, not a hand-picked sample.
 */
describe('planProductPublication — EXHAUSTIVE: no input in the domain ever yields zero channels', () => {
  const REQUESTED_DOMAIN: ReadonlyArray<'mx' | 'us' | null | undefined> = [undefined, null, 'mx', 'us']
  const SELLER_MARKET_DOMAIN: ReadonlyArray<'mx' | 'us'> = ['mx', 'us']
  const FLAG_DOMAIN: readonly boolean[] = [true, false]

  it('covers every (requested × sellerMarket × ownedShopOnlyEnabled) combination', () => {
    let channelsOutcomes = 0
    let refusedOutcomes = 0
    for (const requested of REQUESTED_DOMAIN) {
      for (const sellerMarket of SELLER_MARKET_DOMAIN) {
        for (const ownedShopOnlyEnabled of FLAG_DOMAIN) {
          const plan = planProductPublication({ requested, sellerMarket, ownedShopOnlyEnabled }, PROD_ENV)
          if (plan.status === 'channels') {
            channelsOutcomes += 1
            // The property under test: a 'channels' result is NEVER an empty set, and
            // the operating channel — buyability — is ALWAYS one of its members (D2).
            expect(plan.channel_ids.length).toBeGreaterThan(0)
            expect(plan.channel_ids).toContain(plan.operating_channel_id)
          } else {
            refusedOutcomes += 1
            // A refusal is a REFUSAL, not a degraded success — it must carry an error
            // status, never 2xx (AGENTS: "a partial run that returns 2xx is a defect").
            expect(plan.http_status).toBeGreaterThanOrEqual(400)
          }
        }
      }
    }
    // Pin the shape of the answer, not just its internal consistency — a helper that
    // always refused (or always succeeded) would pass every assertion above and prove
    // nothing. This is the population: 16 combinations, both outcomes represented.
    expect(channelsOutcomes + refusedOutcomes).toBe(16)
    expect(channelsOutcomes).toBeGreaterThan(0)
    expect(refusedOutcomes).toBeGreaterThan(0)
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

  it('a US operating-channel outage names the US env var and never tells the operator to configure MX', () => {
    const plan = planProductPublication(
      { sellerMarket: 'us' },
      { MEDUSA_US_MARKETPLACE_CHANNEL_ID: US_MARKETPLACE },
    )
    expect(plan.status).toBe('refused')
    if (plan.status !== 'refused') throw new Error('unreachable')
    expect(plan.http_status).toBe(503)
    expect(plan.message).toMatch(/MEDUSA_US_OPERATING_CHANNEL_ID/)
    expect(plan.message).not.toMatch(/MEDUSA_MX_OPERATING_CHANNEL_ID/)
    expect(JSON.stringify(plan)).not.toContain(MX_CHANNEL)
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

  it('a US seller gets its own operating + marketplace channels and no MX leakage', () => {
    const plan = planProductPublication({ sellerMarket: 'us' }, TWO_MARKET_ENV)
    if (plan.status !== 'channels') throw new Error('unreachable')
    expect([...plan.channel_ids]).toEqual([US_OPERATING, US_MARKETPLACE])
    expect(JSON.stringify(plan)).not.toContain(MX_OPERATING)
    expect(JSON.stringify(plan)).not.toContain(MX_CHANNEL)
  })

  it('an unknown seller market throws rather than defaulting to MX', () => {
    // The parent epic's write-default rule: a shop whose market we cannot classify is
    // never adopted into Mexico's commerce rails.
    expect(() => planProductPublication({ sellerMarket: 'zz' as never }, PROD_ENV))
      .toThrow(UnknownMarketError)
  })
})

/**
 * ── S3.2 — publish/unpublish an EXISTING product (D11) ────────────────────────────
 * `planPublicationChange` never touches the operating channel — these specs assert
 * that structurally (the operating id never appears in a plan this function
 * produces) rather than merely trusting the code doesn't call the wrong workflow.
 */
describe('planPublicationChange — publish/unpublish touches ONLY the marketplace channel', () => {
  it('flag OFF refuses BOTH directions — publish and unpublish alike (423, Locked)', () => {
    const unpublish = planPublicationChange({ requested: null, sellerMarket: 'mx' }, PROD_ENV)
    const publish = planPublicationChange({ requested: 'mx', sellerMarket: 'mx' }, PROD_ENV)
    for (const plan of [unpublish, publish]) {
      expect(plan.status).toBe('refused')
      if (plan.status !== 'refused') throw new Error('unreachable')
      expect(plan.http_status).toBe(423)
      // Never names a channel id in a refusal body.
      expect(JSON.stringify(plan)).not.toContain(MX_CHANNEL)
      expect(JSON.stringify(plan)).not.toContain(MX_OPERATING)
    }
  })

  it('unpublish (null) removes ONLY the marketplace channel — the operating id never appears', () => {
    const plan = planPublicationChange(
      { requested: null, sellerMarket: 'mx', ownedShopOnlyEnabled: true },
      PROD_ENV,
    )
    expect(plan.status).toBe('remove_marketplace')
    if (plan.status !== 'remove_marketplace') throw new Error('unreachable')
    expect(plan.marketplace_channel_id).toBe(MX_CHANNEL)
    expect(JSON.stringify(plan)).not.toContain(MX_OPERATING)
  })

  it('publish (mx) adds ONLY the marketplace channel — the operating id never appears', () => {
    const plan = planPublicationChange(
      { requested: 'mx', sellerMarket: 'mx', ownedShopOnlyEnabled: true },
      PROD_ENV,
    )
    expect(plan.status).toBe('add_marketplace')
    if (plan.status !== 'add_marketplace') throw new Error('unreachable')
    expect(plan.marketplace_channel_id).toBe(MX_CHANNEL)
    expect(JSON.stringify(plan)).not.toContain(MX_OPERATING)
  })

  it('publish cannot be smuggled into another market by naming it explicitly', () => {
    const plan = planPublicationChange(
      { requested: 'us', sellerMarket: 'mx', ownedShopOnlyEnabled: true },
      PROD_ENV,
    )
    expect(plan.status).toBe('refused')
    if (plan.status !== 'refused') throw new Error('unreachable')
    expect(plan.http_status).toBe(422)
    expect(plan.message).toMatch(/específica de cada país/)
  })

  it('publishing a US product adds only the US marketplace channel', () => {
    const plan = planPublicationChange(
      { requested: 'us', sellerMarket: 'us', ownedShopOnlyEnabled: true },
      TWO_MARKET_ENV,
    )
    expect(plan).toEqual({
      status: 'add_marketplace',
      market: 'us',
      marketplace_channel_id: US_MARKETPLACE,
    })
    expect(JSON.stringify(plan)).not.toContain(US_OPERATING)
    expect(JSON.stringify(plan)).not.toContain(MX_CHANNEL)
  })

  it('unpublish fails closed (503) when the marketplace channel itself is unconfigured', () => {
    const plan = planPublicationChange(
      { requested: null, sellerMarket: 'mx', ownedShopOnlyEnabled: true },
      { MEDUSA_MX_OPERATING_CHANNEL_ID: MX_OPERATING }, // marketplace var missing
    )
    expect(plan.status).toBe('refused')
    if (plan.status !== 'refused') throw new Error('unreachable')
    expect(plan.http_status).toBe(503)
  })

  it('EXHAUSTIVE: no combination in this function\'s domain ever names the operating channel', () => {
    // Same discrete-domain argument as planProductPublication's exhaustive spec
    // above, applied to the update-time sibling: `requested` ∈ {null, 'mx', 'us'},
    // `sellerMarket` ∈ {'mx', 'us'}, `ownedShopOnlyEnabled` ∈ {true, false} — 3 × 2 ×
    // 2 = 12 combinations, all of them.
    const REQUESTED_DOMAIN: ReadonlyArray<'mx' | 'us' | null> = [null, 'mx', 'us']
    const SELLER_MARKET_DOMAIN: ReadonlyArray<'mx' | 'us'> = ['mx', 'us']
    const FLAG_DOMAIN: readonly boolean[] = [true, false]
    let evaluated = 0
    for (const requested of REQUESTED_DOMAIN) {
      for (const sellerMarket of SELLER_MARKET_DOMAIN) {
        for (const ownedShopOnlyEnabled of FLAG_DOMAIN) {
          evaluated += 1
          const plan = planPublicationChange({ requested, sellerMarket, ownedShopOnlyEnabled }, PROD_ENV)
          expect(JSON.stringify(plan)).not.toContain(MX_OPERATING)
        }
      }
    }
    expect(evaluated).toBe(12)
  })
})
