/**
 * Resolves the slug of the platform-owned seller that bills print-ad
 * placements (and mints platform/referral coupons) — config-addressable via
 * `PLATFORM_SELLER_SLUG`, not a hardcoded merchant-shop constant. An explicit
 * override (e.g. a caller-supplied `seller_slug`) always wins over the env var.
 */
export function resolvePlatformSellerSlug(override?: unknown): string | null {
  const safeOverride = typeof override === 'string' ? override : ''
  const slug = (safeOverride || process.env.PLATFORM_SELLER_SLUG || '').trim()
  return slug || null
}
