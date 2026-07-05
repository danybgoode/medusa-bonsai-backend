import { validateTierLadder, type PriceTier } from '../price-tiers'

/**
 * Custom print products · Sprint 2, Story 2.2.
 * Pure validation for seller-defined quantity price tiers — the gate the
 * seller-product-update.ts write path trusts before ever touching Medusa's
 * Pricing module. No DB, no Medusa services.
 */

const VALID_LADDER: PriceTier[] = [
  { min_quantity: 1, max_quantity: 9, amount: 1000 },
  { min_quantity: 10, max_quantity: 49, amount: 800 },
  { min_quantity: 50, max_quantity: null, amount: 600 },
]

describe('validateTierLadder', () => {
  it('accepts a well-formed, contiguous, open-ended ladder', () => {
    expect(validateTierLadder(VALID_LADDER)).toEqual({ ok: true })
  })

  it('accepts a single flat tier (no breaks — the minimal valid ladder)', () => {
    expect(validateTierLadder([{ min_quantity: 1, max_quantity: null, amount: 500 }])).toEqual({ ok: true })
  })

  it('rejects an empty ladder', () => {
    expect(validateTierLadder([])).toEqual(
      expect.objectContaining({ ok: false, message: expect.any(String) }),
    )
  })

  it('rejects a ladder that does not start at min_quantity 1', () => {
    const result = validateTierLadder([{ min_quantity: 2, max_quantity: null, amount: 500 }])
    expect(result.ok).toBe(false)
  })

  it('rejects an overlapping ladder', () => {
    const result = validateTierLadder([
      { min_quantity: 1, max_quantity: 10, amount: 1000 },
      { min_quantity: 5, max_quantity: null, amount: 800 }, // overlaps 5-10
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/traslaparse/)
  })

  it('rejects a gapped ladder', () => {
    const result = validateTierLadder([
      { min_quantity: 1, max_quantity: 9, amount: 1000 },
      { min_quantity: 11, max_quantity: null, amount: 800 }, // gap at 10
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/huecos/)
  })

  it('rejects a ladder whose last tier is bounded (leaves quantities above it unpriced)', () => {
    const result = validateTierLadder([
      { min_quantity: 1, max_quantity: 9, amount: 1000 },
      { min_quantity: 10, max_quantity: 20, amount: 800 },
    ])
    expect(result.ok).toBe(false)
  })

  it('rejects a ladder with a non-positive amount', () => {
    const result = validateTierLadder([{ min_quantity: 1, max_quantity: null, amount: 0 }])
    expect(result.ok).toBe(false)
  })

  it('is order-independent (sorts before validating)', () => {
    const shuffled = [VALID_LADDER[2], VALID_LADDER[0], VALID_LADDER[1]]
    expect(validateTierLadder(shuffled)).toEqual({ ok: true })
  })
})
