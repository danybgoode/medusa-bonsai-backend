import { slugify } from '../route'

/**
 * Regression for the 2026-07-15 empty-slug incident: `POST /store/sellers/me`
 * used to persist `slug: ''` for a name that slugifies to nothing (all-emoji/
 * punctuation/CJK), since nothing guarded `slugify(...)`'s output before it was
 * saved. The fallback itself (`slugify(...) || 'tienda'`) lives in route.ts —
 * this locks the pure half of that contract: slugify() genuinely CAN return ''
 * for exactly the inputs that motivate the fallback, so removing it silently
 * reopens the bug.
 */
describe('slugify', () => {
  it('lowercases, strips accents, and hyphenates', () => {
    expect(slugify('Café Bonito')).toBe('cafe-bonito')
  })

  it('collapses non-alphanumeric runs into a single hyphen, trimmed', () => {
    expect(slugify('  --Hola!! Mundo??--  ')).toBe('hola-mundo')
  })

  it('returns empty for an all-emoji name — the input that motivates the || "tienda" fallback', () => {
    expect(slugify('🎉🎉🎉')).toBe('')
  })

  it('returns empty for an all-punctuation name', () => {
    expect(slugify('!!!???')).toBe('')
  })

  it('truncates to 60 characters', () => {
    expect(slugify('a'.repeat(100)).length).toBe(60)
  })
})
