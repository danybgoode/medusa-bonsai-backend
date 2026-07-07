import { deriveProofRestatement } from '../proof-restatement'

/**
 * Custom print products · Sprint 4, Story 4.1.
 * The proof-restatement builder is the StickerJunkie-pitfall guard: size,
 * quantity, and price must always come from the order's own line item, never
 * from anything a caller supplies. These specs pin that contract.
 */

describe('deriveProofRestatement', () => {
  it('derives size/quantity/price straight from the line item', () => {
    const result = deriveProofRestatement({
      variant_title: '7.5cm / Mate',
      quantity: 25,
      unit_price: 400,
    })
    expect(result).toEqual({ size: '7.5cm / Mate', quantity: 25, priceCents: 10000 })
  })

  it('falls back through subtitle → product_title → title when variant_title is absent', () => {
    expect(deriveProofRestatement({ subtitle: 'Mate', quantity: 1, unit_price: 100 }).size).toBe('Mate')
    expect(deriveProofRestatement({ product_title: 'Sticker redondo', quantity: 1, unit_price: 100 }).size).toBe('Sticker redondo')
    expect(deriveProofRestatement({ title: 'Sticker', quantity: 1, unit_price: 100 }).size).toBe('Sticker')
  })

  it('defaults quantity to 1 when missing or non-numeric — never zero, never NaN', () => {
    expect(deriveProofRestatement({ unit_price: 500 }).quantity).toBe(1)
    expect(deriveProofRestatement({ quantity: 0, unit_price: 500 }).quantity).toBe(1)
  })

  it('never produces NaN price when unit_price is missing', () => {
    const result = deriveProofRestatement({ quantity: 10 })
    expect(result.priceCents).toBe(0)
    expect(Number.isNaN(result.priceCents)).toBe(false)
  })

  it('multiplies unit price by quantity for the restated total', () => {
    expect(deriveProofRestatement({ quantity: 3, unit_price: 1200 }).priceCents).toBe(3600)
  })
})
