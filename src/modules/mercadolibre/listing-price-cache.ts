/**
 * listing-price-cache — the PURE half of the fee-estimate cache (Sprint 2 ·
 * US-4, profit-analyzer). Mirrors the shape of `src/lib/flags-cache.ts` (key
 * resolution + staleness are pure, unit-testable functions; the stateful
 * Map + the actual ML fetch live in `service.ts`) — but keyed, since a fee
 * rate is per site/category/listing-type rather than one global value.
 *
 * The fee RATE (percentage + fixed fee) for a category/listing-type is
 * stable across price points in the normal case, so caching it lets the
 * frontend move a target-margin slider locally (recomputing via the pure
 * `solveForPrice`) without a network round-trip per tick. Apply-price
 * (US-5) re-validates the actual write against ML directly, so a stale
 * cached rate here can only mis-suggest, never mis-write.
 */

/** One cached entry: the fee rate ML quoted, as of `fetchedAt` (epoch ms). */
export type ListingPriceCacheEntry = {
  feePct: number
  fixedFeeCents: number
  currency: string
  fetchedAt: number
}

/** In-process cache TTL — how long a fetched rate is trusted before a refresh. */
export const LISTING_PRICE_CACHE_TTL_MS = 60_000

/** The cache key for one site/category/listing-type combination. */
export function buildListingPriceCacheKey(siteId: string, categoryId: string, listingTypeId: string): string {
  return `${siteId}:${categoryId}:${listingTypeId}`
}

/** Is a cached entry stale (needs a refresh)? True when absent or aged past `ttlMs`. */
export function isListingPriceEntryStale(
  entry: ListingPriceCacheEntry | null | undefined,
  now: number,
  ttlMs: number = LISTING_PRICE_CACHE_TTL_MS,
): boolean {
  if (!entry) return true
  return now - entry.fetchedAt >= ttlMs
}
