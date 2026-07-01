import {
  resolveFlag,
  isCacheStale,
  FLAG_CACHE_TTL_MS,
  FLAG_FETCH_TIMEOUT_MS,
  type FlagRow,
} from '../flags-cache'

/**
 * In-house feature flags · Sprint 1 (backend reader, epic 09 · feature-flags-inhouse).
 * Pure-seam coverage for the FAIL-OPEN decision that src/lib/flags.ts composes around
 * the Supabase read — no DB, no network. Mirrors the FE e2e/flags-cache.spec.ts. Both
 * polarities are exercised (a kill-switch default true + an enablement default false).
 */

const DEFAULTS = {
  'checkout.stripe_enabled': true, // kill-switch → fail-open ON
  'shipping.envia_enabled': false, // enablement → fail-open OFF
} as const

describe('flags-cache · resolveFlag (fail-open)', () => {
  it('returns the row value when the key is present (overrides the default, both ways)', () => {
    const rows: FlagRow[] = [
      { key: 'checkout.stripe_enabled', enabled: false }, // killed despite default ON
      { key: 'shipping.envia_enabled', enabled: true }, // enabled despite default OFF
    ]
    expect(resolveFlag(rows, 'checkout.stripe_enabled', DEFAULTS)).toBe(false)
    expect(resolveFlag(rows, 'shipping.envia_enabled', DEFAULTS)).toBe(true)
  })

  it('falls open to the default when the row is missing (both polarities)', () => {
    const rows: FlagRow[] = [{ key: 'some.other_flag', enabled: false }]
    expect(resolveFlag(rows, 'checkout.stripe_enabled', DEFAULTS)).toBe(true)
    expect(resolveFlag(rows, 'shipping.envia_enabled', DEFAULTS)).toBe(false)
  })

  it('falls open to the default on empty / null / undefined rows', () => {
    for (const rows of [[], null, undefined] as const) {
      expect(resolveFlag(rows, 'checkout.stripe_enabled', DEFAULTS)).toBe(true)
      expect(resolveFlag(rows, 'shipping.envia_enabled', DEFAULTS)).toBe(false)
    }
  })

  it('falls open when a row has a non-boolean enabled value', () => {
    const rows = [{ key: 'checkout.stripe_enabled', enabled: 'yes' as unknown as boolean }]
    expect(resolveFlag(rows, 'checkout.stripe_enabled', DEFAULTS)).toBe(true)
  })
})

describe('flags-cache · isCacheStale', () => {
  it('is stale when never fetched (fetchedAt null)', () => {
    expect(isCacheStale(null, 1_000, FLAG_CACHE_TTL_MS)).toBe(true)
  })

  it('is fresh within the TTL, stale at/after it', () => {
    const now = 1_000_000
    expect(isCacheStale(now, now, FLAG_CACHE_TTL_MS)).toBe(false) // just fetched
    expect(isCacheStale(now - (FLAG_CACHE_TTL_MS - 1), now, FLAG_CACHE_TTL_MS)).toBe(false)
    expect(isCacheStale(now - FLAG_CACHE_TTL_MS, now, FLAG_CACHE_TTL_MS)).toBe(true) // exactly TTL
    expect(isCacheStale(now - (FLAG_CACHE_TTL_MS + 1), now, FLAG_CACHE_TTL_MS)).toBe(true)
  })
})

describe('flags-cache · constants', () => {
  it('TTL is 60 s and the fetch budget is 2 s', () => {
    expect(FLAG_CACHE_TTL_MS).toBe(60_000)
    expect(FLAG_FETCH_TIMEOUT_MS).toBe(2_000)
  })
})
