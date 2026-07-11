import { resolvePlatformSellerSlug } from '../platform-seller'

/**
 * Panfleto Sprint 1 — the platform-owned seller is config-addressable via
 * `PLATFORM_SELLER_SLUG`, never a hardcoded merchant-shop constant. Pure
 * function — no DB, no Medusa container.
 */
describe('resolvePlatformSellerSlug', () => {
  const ORIGINAL_ENV = process.env.PLATFORM_SELLER_SLUG

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.PLATFORM_SELLER_SLUG
    else process.env.PLATFORM_SELLER_SLUG = ORIGINAL_ENV
  })

  it('returns null when unset', () => {
    delete process.env.PLATFORM_SELLER_SLUG
    expect(resolvePlatformSellerSlug()).toBeNull()
  })

  it('returns the env var value when set', () => {
    process.env.PLATFORM_SELLER_SLUG = 'miyagiprints'
    expect(resolvePlatformSellerSlug()).toBe('miyagiprints')
  })

  it('an explicit override wins over the env var', () => {
    process.env.PLATFORM_SELLER_SLUG = 'miyagiprints'
    expect(resolvePlatformSellerSlug('miyagi-plataforma')).toBe('miyagi-plataforma')
  })

  it('a blank/whitespace-only env var resolves to null, not an empty string', () => {
    process.env.PLATFORM_SELLER_SLUG = '   '
    expect(resolvePlatformSellerSlug()).toBeNull()
  })

  it('an empty-string override falls through to the env var', () => {
    process.env.PLATFORM_SELLER_SLUG = 'miyagiprints'
    expect(resolvePlatformSellerSlug('')).toBe('miyagiprints')
  })

  it('a non-string override (e.g. a duplicate query param parsed as an array) falls through safely, no crash', () => {
    process.env.PLATFORM_SELLER_SLUG = 'miyagiprints'
    expect(resolvePlatformSellerSlug(['a', 'b'])).toBe('miyagiprints')
    expect(resolvePlatformSellerSlug({ nope: true })).toBe('miyagiprints')
  })
})
