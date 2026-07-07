import { splitCategories } from '../category-split'

describe('splitCategories', () => {
  it('finds the platform category regardless of array position', () => {
    const result = splitCategories(
      [
        { id: 'cat_zines', handle: 'miyagiprints-zines' },
        { id: 'cat_moda', handle: 'moda' },
        { id: 'cat_diecut', handle: 'miyagiprints-die-cut' },
      ],
      'miyagiprints',
    )
    expect(result.platformCategory?.handle).toBe('moda')
    expect(result.collections.map((c) => c.handle)).toEqual([
      'miyagiprints-zines',
      'miyagiprints-die-cut',
    ])
  })

  it('sorts collections by metadata.sort_order, untagged last', () => {
    const result = splitCategories(
      [
        { id: 'cat_a', handle: 'miyagiprints-b', metadata: { sort_order: 1 } },
        { id: 'cat_b', handle: 'miyagiprints-a', metadata: { sort_order: 0 } },
        { id: 'cat_c', handle: 'miyagiprints-untagged' },
      ],
      'miyagiprints',
    )
    expect(result.collections.map((c) => c.handle)).toEqual([
      'miyagiprints-a',
      'miyagiprints-b',
      'miyagiprints-untagged',
    ])
  })

  it('returns null platformCategory when only seller collections are attached', () => {
    const result = splitCategories(
      [{ id: 'cat_a', handle: 'miyagiprints-die-cut' }],
      'miyagiprints',
    )
    expect(result.platformCategory).toBeNull()
    expect(result.collections).toHaveLength(1)
  })

  it('handles empty/absent categories without crashing', () => {
    expect(splitCategories(null, 'miyagiprints')).toEqual({ platformCategory: null, collections: [] })
    expect(splitCategories(undefined, 'miyagiprints')).toEqual({ platformCategory: null, collections: [] })
    expect(splitCategories([], 'miyagiprints')).toEqual({ platformCategory: null, collections: [] })
  })

  it('treats every category as platform-only when sellerSlug is absent', () => {
    const result = splitCategories(
      [{ id: 'cat_a', handle: 'moda' }],
      null,
    )
    expect(result.platformCategory?.handle).toBe('moda')
    expect(result.collections).toEqual([])
  })

  it('never misclassifies a DIFFERENT seller\'s collection handle as this seller\'s own', () => {
    const result = splitCategories(
      [{ id: 'cat_other', handle: 'otherseller-zines' }],
      'miyagiprints',
    )
    // "otherseller-zines" doesn't match the "miyagiprints-" prefix, so it is
    // never pushed into `collections` (which would wrongly imply this seller
    // owns it). This shape can't actually occur in practice — ownership is
    // enforced at write time in seller-collections.ts — but the split itself
    // must never conflate a foreign-namespaced handle with this seller's own.
    expect(result.collections).toEqual([])
  })
})
