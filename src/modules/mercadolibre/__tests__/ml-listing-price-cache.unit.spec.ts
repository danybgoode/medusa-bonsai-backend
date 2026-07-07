import {
  buildListingPriceCacheKey,
  isListingPriceEntryStale,
  LISTING_PRICE_CACHE_TTL_MS,
  type ListingPriceCacheEntry,
} from '../listing-price-cache'

/**
 * Mercado Libre module · Sprint 2 · US-4 — the fee-estimate cache's pure
 * half (key building + staleness). No DB, no network, no Map — the stateful
 * Map + the ML fetch live in `service.ts`.
 */
describe('buildListingPriceCacheKey', () => {
  it('joins site, category and listing-type into one key', () => {
    expect(buildListingPriceCacheKey('MLM', 'MLM1234', 'bronze')).toBe('MLM:MLM1234:bronze')
  })

  it('keys different categories/listing-types distinctly', () => {
    const a = buildListingPriceCacheKey('MLM', 'MLM1234', 'bronze')
    const b = buildListingPriceCacheKey('MLM', 'MLM5678', 'bronze')
    const c = buildListingPriceCacheKey('MLM', 'MLM1234', 'gold_special')
    expect(new Set([a, b, c]).size).toBe(3)
  })
})

const entry = (over: Partial<ListingPriceCacheEntry> = {}): ListingPriceCacheEntry => ({
  feePct: 0.1,
  fixedFeeCents: 0,
  currency: 'MXN',
  fetchedAt: 1_000_000,
  ...over,
})

describe('isListingPriceEntryStale', () => {
  it('is stale when there is no entry', () => {
    expect(isListingPriceEntryStale(null, 1_000_000)).toBe(true)
    expect(isListingPriceEntryStale(undefined, 1_000_000)).toBe(true)
  })

  it('is fresh just under the TTL', () => {
    const e = entry({ fetchedAt: 1_000_000 })
    expect(isListingPriceEntryStale(e, 1_000_000 + LISTING_PRICE_CACHE_TTL_MS - 1)).toBe(false)
  })

  it('is stale exactly at and past the TTL', () => {
    const e = entry({ fetchedAt: 1_000_000 })
    expect(isListingPriceEntryStale(e, 1_000_000 + LISTING_PRICE_CACHE_TTL_MS)).toBe(true)
    expect(isListingPriceEntryStale(e, 1_000_000 + LISTING_PRICE_CACHE_TTL_MS + 1)).toBe(true)
  })
})
