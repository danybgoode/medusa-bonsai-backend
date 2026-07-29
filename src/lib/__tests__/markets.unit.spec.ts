import {
  DEFAULT_MARKET,
  MARKETS,
  MARKET_CODES,
  UnknownMarketError,
  getMarket,
  isMarketCode,
  isMarketplaceOpen,
  looksLikeLocale,
  marketBasePath,
  normalizeMarketCode,
  openMarketCodes,
  requireMarket,
} from '../markets'

/**
 * THE GOLDEN SPEC for the market registry (epic market-architecture-foundation, D2).
 *
 * `src/lib/markets.ts` is duplicated BYTE-FOR-BYTE in `apps/miyagisanchez/lib/
 * markets.ts`. There is no shared package — the two repos have different build
 * systems — so the contract is held honest by this spec and its twin on the frontend
 * asserting EVERY FIELD OF EVERY RECORD. If one copy drifts, that copy's own gate
 * goes red instead of the drift being discovered by a buyer in the wrong country.
 *
 * That is why the assertions below are deliberately literal rather than derived from
 * the module: a spec that computes its expectation from the thing under test cannot
 * detect a change to the thing under test.
 */
describe('markets registry — golden record', () => {
  it('declares exactly mx and us, in selector display order', () => {
    expect(MARKET_CODES).toEqual(['mx', 'us'])
    expect(Object.keys(MARKETS)).toEqual(['mx', 'us'])
  })

  it('mx — every field', () => {
    expect(MARKETS.mx).toEqual({
      code: 'mx',
      country_code: 'mx',
      currency_code: 'mxn',
      default_locale: 'es-MX',
      timezone: 'America/Mexico_City',
      marketplace_status: 'active',
    })
  })

  it('us — every field, and it is invitation (fail-closed), not active', () => {
    expect(MARKETS.us).toEqual({
      code: 'us',
      country_code: 'us',
      currency_code: 'usd',
      default_locale: 'en-US',
      timezone: 'America/New_York',
      marketplace_status: 'invitation',
    })
  })

  it('DEFAULT_MARKET is mx — the pre-launch backward-compatibility default', () => {
    expect(DEFAULT_MARKET).toBe('mx')
  })

  it('records are frozen — the registry cannot be mutated at runtime', () => {
    expect(Object.isFrozen(MARKETS)).toBe(true)
    expect(Object.isFrozen(MARKETS.mx)).toBe(true)
    expect(Object.isFrozen(MARKETS.us)).toBe(true)
  })

  it('carries no Medusa Region or Sales Channel id (D2 — ids are environment-resolved)', () => {
    for (const code of MARKET_CODES) {
      const keys = Object.keys(MARKETS[code])
      expect(keys).not.toContain('region_id')
      expect(keys).not.toContain('sales_channel_id')
      expect(JSON.stringify(MARKETS[code])).not.toMatch(/\b(reg|sc)_[A-Z0-9]{10,}/)
    }
  })
})

describe('markets registry — narrowing', () => {
  it('accepts a supported code, case-insensitively and trimmed', () => {
    expect(isMarketCode('mx')).toBe(true)
    expect(isMarketCode('MX')).toBe(true)
    expect(isMarketCode(' us ')).toBe(true)
    expect(normalizeMarketCode(' US ')).toBe('us')
  })

  it('rejects everything else — including a locale, a currency and a padded variant', () => {
    for (const value of ['es-MX', 'en-US', 'mxn', 'usd', 'mex', 'mx1', 'm', '', null, undefined, 42, {}, ['mx']]) {
      expect(isMarketCode(value)).toBe(false)
      expect(normalizeMarketCode(value)).toBeNull()
      expect(getMarket(value)).toBeNull()
    }
  })
})

describe('markets registry — requireMarket rejects a locale loudly (D3)', () => {
  it('throws UnknownMarketError naming the LOCALE mistake', () => {
    expect(() => requireMarket('es-MX')).toThrow(UnknownMarketError)
    try {
      requireMarket('es-MX')
    } catch (e) {
      expect((e as Error).message).toMatch(/LOCALE/)
      expect((e as Error).message).toMatch(/es-MX/)
      expect((e as UnknownMarketError).value).toBe('es-MX')
    }
  })

  it('throws without the locale hint for a plain unsupported code', () => {
    try {
      requireMarket('ca')
    } catch (e) {
      expect((e as Error).message).toMatch(/Unsupported market/)
      expect((e as Error).message).not.toMatch(/LOCALE/)
    }
  })

  it('never resolves an unknown market to Mexico', () => {
    for (const value of ['us-CA', 'ca', 'br', '', null, undefined]) {
      expect(() => requireMarket(value)).toThrow(UnknownMarketError)
    }
  })

  it('looksLikeLocale only ever upgrades a message — it accepts nothing', () => {
    expect(looksLikeLocale('es-MX')).toBe(true)
    expect(looksLikeLocale('es_MX')).toBe(true)
    expect(looksLikeLocale('spa')).toBe(true)
    expect(looksLikeLocale('mx')).toBe(false)
    expect(looksLikeLocale(42)).toBe(false)
    // …and even for a locale-shaped string, it is still not a market.
    expect(isMarketCode('es-MX')).toBe(false)
  })
})

describe('markets registry — marketplace openness is an ALLOW-list', () => {
  it('mx is open, us is not', () => {
    expect(isMarketplaceOpen('mx')).toBe(true)
    expect(isMarketplaceOpen('us')).toBe(false)
  })

  it('an unknown value is not open (a deny-list would have called it good)', () => {
    for (const value of ['ca', 'es-MX', '', null, undefined, {}]) {
      expect(isMarketplaceOpen(value)).toBe(false)
    }
  })

  it('openMarketCodes is derived from the records, not a second list', () => {
    expect(openMarketCodes()).toEqual(['mx'])
    expect(openMarketCodes().every((code) => MARKETS[code].marketplace_status === 'active')).toBe(true)
  })
})

describe('markets registry — marketBasePath', () => {
  it('renders the public prefix for a supported market', () => {
    expect(marketBasePath('mx')).toBe('/mx')
    expect(marketBasePath('US')).toBe('/us')
  })

  it('throws rather than emitting a path for an unknown market', () => {
    expect(() => marketBasePath('es-MX')).toThrow(UnknownMarketError)
  })
})
