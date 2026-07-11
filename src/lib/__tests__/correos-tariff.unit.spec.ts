import { quoteCorreos, quoteCorreosForPieces, CORREOS_IMPRESOS_BANDS_2026, CORREOS_IMPRESOS_MAX_GRAMS } from '../correos-tariff'

/**
 * Correos de México — Impresos en General tariff (shipping-provider-expansion epic,
 * Sprint 3, Story 3.1). Spec-locked band-by-band to `references/correos-de-mexico-impresos.pdf`
 * ("TARIFA POSTAL 2026" sheet, Impresos en General, depósitos individuales nacional).
 * Pure function — no flag store, no DB.
 */

describe('quoteCorreos · band edges (pinned to the 2026 PDF)', () => {
  const cases: Array<[number, number]> = [
    [20, 600],
    [40, 700],
    [60, 800],
    [80, 900],
    [100, 950],
    [150, 1050],
    [200, 1150],
    [250, 1350],
    [300, 1450],
    [350, 1550],
    [400, 1700],
    [450, 1800],
    [500, 1850],
    [600, 1900],
    [700, 2000],
    [800, 2050],
    [900, 2150],
    [1000, 2250],
    [1100, 2300],
    [1200, 2350],
    [1300, 2400],
    [1400, 2450],
    [1500, 2500],
    [1600, 2600],
    [1700, 2650],
    [1800, 2700],
    [1900, 2800],
    [2000, 2900],
  ]

  it.each(cases)('exactly %d g → %d cents', (grams, cents) => {
    expect(quoteCorreos(grams)).toEqual({ totalCents: cents, maxGrams: grams })
  })

  it('has exactly 28 bands, matching the PDF row count', () => {
    expect(CORREOS_IMPRESOS_BANDS_2026).toHaveLength(28)
  })

  it('the table max is 2000 g', () => {
    expect(CORREOS_IMPRESOS_MAX_GRAMS).toBe(2000)
  })
})

describe('quoteCorreos · a weight inside a band rounds UP to that band, not down', () => {
  it('19 g and 1 g both land in the ≤20 g band', () => {
    expect(quoteCorreos(19)).toEqual({ totalCents: 600, maxGrams: 20 })
    expect(quoteCorreos(1)).toEqual({ totalCents: 600, maxGrams: 20 })
  })

  it('21 g lands in the >20–40 g band, not the ≤20 g band', () => {
    expect(quoteCorreos(21)).toEqual({ totalCents: 700, maxGrams: 40 })
  })

  it('1901 g lands in the final 1900–2000 g band', () => {
    expect(quoteCorreos(1901)).toEqual({ totalCents: 2900, maxGrams: 2000 })
  })
})

describe('quoteCorreos · out-of-table weights return null, never an invented price', () => {
  it('over the 2000 g max → null', () => {
    expect(quoteCorreos(2001)).toBeNull()
    expect(quoteCorreos(5000)).toBeNull()
  })

  it('non-positive → null', () => {
    expect(quoteCorreos(0)).toBeNull()
    expect(quoteCorreos(-1)).toBeNull()
  })

  it('non-finite → null', () => {
    expect(quoteCorreos(NaN)).toBeNull()
    expect(quoteCorreos(Infinity)).toBeNull()
  })
})

describe('quoteCorreosForPieces · multi-piece shipments sum PER-PIECE quotes, never one combined weight', () => {
  it('sums each piece\'s own band price — two 1500 g pieces is NOT one 3000 g quote', () => {
    // Cross-review catch: the table is "peso en gramos por pieza." Two 1500 g
    // pieces quote at $25.00 each ($50.00 total) — summing to 3000 g first
    // would wrongly return null (over the 2000 g table max).
    expect(quoteCorreosForPieces([1500, 1500])).toEqual({ totalCents: 5000, maxGrams: 1500 })
  })

  it('a single-piece list matches quoteCorreos exactly', () => {
    expect(quoteCorreosForPieces([500])).toEqual(quoteCorreos(500))
  })

  it('mixed light + heavy pieces sum correctly', () => {
    // 20 g piece ($6.00) + 2000 g piece ($29.00) = $35.00, maxGrams tracks the heaviest band.
    expect(quoteCorreosForPieces([20, 2000])).toEqual({ totalCents: 3500, maxGrams: 2000 })
  })

  it('ANY single piece over the max fails the whole quote (never drops it silently)', () => {
    expect(quoteCorreosForPieces([500, 2001])).toBeNull()
  })

  it('an empty piece list → null', () => {
    expect(quoteCorreosForPieces([])).toBeNull()
  })

  it('a non-positive/non-finite piece anywhere in the list → null', () => {
    expect(quoteCorreosForPieces([500, 0])).toBeNull()
    expect(quoteCorreosForPieces([500, NaN])).toBeNull()
  })
})
