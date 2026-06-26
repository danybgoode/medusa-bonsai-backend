import { isFeaturedPin } from '../listing'

/**
 * seleccion-pins-authoritative · Sprint 2 (S2.1 backend read-filter).
 * `/store/listings?featured=true` filters by this pure predicate. A pin is the
 * strict boolean `metadata.featured === true` (mirrors the frontend `isPinned`),
 * never a truthy/string value. Pure — no DB, no remoteQuery.
 */
describe('isFeaturedPin · /store/listings?featured=true filter', () => {
  it('is true only for metadata.featured === true', () => {
    expect(isFeaturedPin({ metadata: { featured: true } })).toBe(true)
  })

  it('is false when featured is missing', () => {
    expect(isFeaturedPin({ metadata: {} })).toBe(false)
    expect(isFeaturedPin({ metadata: { featured_rank: 1 } })).toBe(false)
  })

  it('is false for explicit featured === false', () => {
    expect(isFeaturedPin({ metadata: { featured: false } })).toBe(false)
  })

  it('is false for the string "true" (no coercion — strict boolean)', () => {
    expect(isFeaturedPin({ metadata: { featured: 'true' } as any })).toBe(false)
  })

  it('is false for null / undefined metadata (no broken pin)', () => {
    expect(isFeaturedPin({ metadata: null })).toBe(false)
    expect(isFeaturedPin({})).toBe(false)
  })

  it('keeps only pins when used as a filter (parity with the route)', () => {
    const listings = [
      { id: 'a', metadata: { featured: true } },
      { id: 'b', metadata: { featured: false } },
      { id: 'c', metadata: {} },
      { id: 'd', metadata: { featured: true, featured_rank: 2 } },
    ]
    expect(listings.filter(isFeaturedPin).map(l => l.id)).toEqual(['a', 'd'])
  })
})
