import { UnknownMarketError } from '../markets'
import {
  SELLER_OPERATING_MARKET_KEY,
  planMarketplaceLinkBackfill,
  planSellerMarketBackfill,
  publicSellerMarket,
  readSellerOperatingMarket,
  requireSellerOperatingMarket,
  resolveSellerMarketContext,
  setSellerOperatingMarket,
} from '../seller-market'

/**
 * The single reader/writer of `seller.metadata.operating_market` (build contract
 * item 2, story 1.2). No container, no database — the whole point of putting the
 * parsing in `lib/` is that the market decision is testable without a seller row.
 */

const PROD_ENV = {
  MEDUSA_SALES_CHANNEL_ID: 'sc_01KSK1J0V81P4EPY9G0JAPX353',
  MEDUSA_MXN_REGION_ID: 'reg_01KSK1HZAWN5ZCSPZ74ER97HD9',
}

describe('readSellerOperatingMarket — three states', () => {
  it('reads a stored value off a seller row', () => {
    expect(readSellerOperatingMarket({ id: 'sel_1', metadata: { operating_market: 'us' } }))
      .toEqual({ market: 'us', source: 'metadata', raw: 'us' })
  })

  it('reads a stored value off a bare metadata bag, normalised', () => {
    expect(readSellerOperatingMarket({ operating_market: ' MX ' }))
      .toEqual({ market: 'mx', source: 'metadata', raw: 'mx' })
  })

  it('ABSENT resolves to mx and SAYS SO (legacy_default — the pre-launch window)', () => {
    for (const source of [undefined, null, {}, { metadata: null }, { metadata: {} }, { id: 'sel_1' }]) {
      expect(readSellerOperatingMarket(source)).toEqual({ market: 'mx', source: 'legacy_default', raw: null })
    }
  })

  it('an unrecognised stored value is INVALID — never silently Mexico', () => {
    for (const raw of ['es-MX', 'ca', 'mexico', 'MXN', 7, {}, true]) {
      const read = readSellerOperatingMarket({ metadata: { operating_market: raw } })
      expect(read.market).toBeNull()
      expect(read.source).toBe('invalid')
      expect(read.raw).toEqual(raw)
    }
  })

  it('requireSellerOperatingMarket throws on an invalid stored value', () => {
    expect(() => requireSellerOperatingMarket({ metadata: { operating_market: 'ca' } }))
      .toThrow(UnknownMarketError)
    expect(requireSellerOperatingMarket({ metadata: { operating_market: 'us' } })).toBe('us')
    expect(requireSellerOperatingMarket({})).toBe('mx')
  })
})

describe('setSellerOperatingMarket — a WRITE requires an explicit supported market', () => {
  it('preserves the rest of the metadata bag', () => {
    const before = { stripe_account_id: 'acct_1', settings: { x: 1 } }
    expect(setSellerOperatingMarket(before, 'us')).toEqual({
      stripe_account_id: 'acct_1',
      settings: { x: 1 },
      [SELLER_OPERATING_MARKET_KEY]: 'us',
    })
    // …and does not mutate the caller's object.
    expect(before).toEqual({ stripe_account_id: 'acct_1', settings: { x: 1 } })
  })

  it('normalises the code', () => {
    expect(setSellerOperatingMarket(null, ' MX ')).toEqual({ operating_market: 'mx' })
  })

  it('REFUSES a locale — no country is ever inferred from a language tag (D3)', () => {
    expect(() => setSellerOperatingMarket({}, 'es-MX')).toThrow(/LOCALE/)
    expect(() => setSellerOperatingMarket({}, 'en-US')).toThrow(UnknownMarketError)
  })

  it('REFUSES an unsupported market and an omitted one — there is no "write the default"', () => {
    expect(() => setSellerOperatingMarket({}, 'ca')).toThrow(UnknownMarketError)
    expect(() => setSellerOperatingMarket({}, undefined)).toThrow(UnknownMarketError)
    expect(() => setSellerOperatingMarket({}, null)).toThrow(UnknownMarketError)
  })
})

describe('resolveSellerMarketContext — an unsupported market cannot inherit Mexico rails', () => {
  it('an mx seller gets the MXN region, the MX marketplace channel and mxn', () => {
    const ctx = resolveSellerMarketContext({ metadata: { operating_market: 'mx' } }, PROD_ENV)
    expect(ctx.market).toBe('mx')
    expect(ctx.currency_code).toBe('mxn')
    expect(ctx.region_id).toBe(PROD_ENV.MEDUSA_MXN_REGION_ID)
    expect(ctx.marketplace_channel_id).toBe(PROD_ENV.MEDUSA_SALES_CHANNEL_ID)
    expect(ctx.marketplace_open).toBe(true)
  })

  it('a us seller gets NO region, NO channel, usd — nothing Mexican leaks across', () => {
    const ctx = resolveSellerMarketContext({ metadata: { operating_market: 'us' } }, PROD_ENV)
    expect(ctx.market).toBe('us')
    expect(ctx.currency_code).toBe('usd')
    expect(ctx.region_id).toBeNull()
    expect(ctx.marketplace_channel_id).toBeNull()
    expect(ctx.marketplace_open).toBe(false)
    // The load-bearing assertion: not merely "null", but specifically NOT Mexico's.
    expect(ctx.region_id).not.toBe(PROD_ENV.MEDUSA_MXN_REGION_ID)
    expect(ctx.marketplace_channel_id).not.toBe(PROD_ENV.MEDUSA_SALES_CHANNEL_ID)
    expect(ctx.currency_code).not.toBe('mxn')
  })

  it('a legacy seller (no value) resolves to mx and reports the legacy source', () => {
    const ctx = resolveSellerMarketContext({ metadata: {} }, PROD_ENV)
    expect(ctx.market).toBe('mx')
    expect(ctx.source).toBe('legacy_default')
  })

  it('an invalid stored market throws instead of resolving any rails', () => {
    expect(() => resolveSellerMarketContext({ metadata: { operating_market: 'ca' } }, PROD_ENV))
      .toThrow(UnknownMarketError)
  })

  it('locale stays presentation — it is a FIELD of the market, never a selector', () => {
    expect(resolveSellerMarketContext({ metadata: { operating_market: 'us' } }, PROD_ENV).default_locale)
      .toBe('en-US')
  })
})

describe('publicSellerMarket — market code without leaking seller metadata', () => {
  it('returns only the three public facts', () => {
    const projection = publicSellerMarket({
      metadata: { operating_market: 'mx', stripe_account_id: 'acct_secret', payout_bank: '1234' },
    })
    expect(projection).toEqual({ market_code: 'mx', country_code: 'mx', marketplace_status: 'active' })
    expect(JSON.stringify(projection)).not.toMatch(/acct_secret|1234/)
  })

  it('reports absence honestly for an unrecognised value rather than claiming mx', () => {
    expect(publicSellerMarket({ metadata: { operating_market: 'ca' } }))
      .toEqual({ market_code: null, country_code: null, marketplace_status: null })
  })
})

describe('planSellerMarketBackfill', () => {
  const sellers = [
    { id: 'sel_legacy', slug: 'a', metadata: { stripe_account_id: 'acct_1' } },
    { id: 'sel_none', slug: 'b', metadata: null },
    { id: 'sel_mx', slug: 'c', metadata: { operating_market: 'mx' } },
    { id: 'sel_us', slug: 'd', metadata: { operating_market: 'us' } },
  ]

  it('proposes mx only for sellers with no value, and leaves explicit markets alone', () => {
    const plan = planSellerMarketBackfill(sellers)
    expect(plan.target).toBe('mx')
    expect(plan.updates.map((u) => u.id)).toEqual(['sel_legacy', 'sel_none'])
    expect(plan.updates.every((u) => u.current === null && u.proposed === 'mx')).toBe(true)
    expect(plan.unchanged.map((u) => u.id)).toEqual(['sel_mx', 'sel_us'])
    // "unspecified means mx" — NOT "everyone is mx".
    expect(plan.updates.map((u) => u.id)).not.toContain('sel_us')
    expect(plan.abort).toBe(false)
  })

  it('ABORTS on an unknown-market population rather than backfilling around it', () => {
    const plan = planSellerMarketBackfill([...sellers, { id: 'sel_bad', slug: 'e', metadata: { operating_market: 'es-MX' } }])
    expect(plan.abort).toBe(true)
    expect(plan.unknown).toEqual([{ id: 'sel_bad', slug: 'e', raw: 'es-MX' }])
    // The unclassifiable row is not quietly swept into the update set.
    expect(plan.updates.map((u) => u.id)).not.toContain('sel_bad')
  })

  it('is a no-op on a second run (idempotent by construction)', () => {
    const applied = sellers.map((s) => ({ ...s, metadata: { ...(s.metadata ?? {}), operating_market: 'mx' } }))
    const plan = planSellerMarketBackfill(applied)
    expect(plan.updates).toEqual([])
    expect(plan.abort).toBe(false)
  })

  it('refuses an unsupported target market', () => {
    expect(() => planSellerMarketBackfill(sellers, 'ca' as never)).toThrow(UnknownMarketError)
  })
})

describe('planMarketplaceLinkBackfill — only the owning seller market may publish', () => {
  it('links mx-owned products, and reports other-market and unowned products separately', () => {
    const plan = planMarketplaceLinkBackfill([
      { id: 'prod_mx', owner_market: 'mx', owner_seller_id: 'sel_mx' },
      { id: 'prod_us', owner_market: 'us', owner_seller_id: 'sel_us' },
      { id: 'prod_orphan', owner_market: null, owner_seller_id: null },
    ])

    expect(plan).toEqual({
      target: 'mx',
      link: ['prod_mx'],
      skipped_other_market: [{ id: 'prod_us', owner_market: 'us' }],
      skipped_unowned: ['prod_orphan'],
    })
  })

  it('never treats the target as a platform default', () => {
    const plan = planMarketplaceLinkBackfill([
      { id: 'prod_mx', owner_market: 'mx' },
      { id: 'prod_us', owner_market: 'us' },
    ], 'us')

    expect(plan.link).toEqual(['prod_us'])
    expect(plan.skipped_other_market).toEqual([{ id: 'prod_mx', owner_market: 'mx' }])
  })

  it('refuses an unsupported target', () => {
    expect(() => planMarketplaceLinkBackfill([], 'ca' as never)).toThrow(UnknownMarketError)
  })
})
