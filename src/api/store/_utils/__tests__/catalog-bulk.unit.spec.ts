import { computeBulkDiff } from '../catalog-bulk'
import type { CatalogPair } from '../seller-catalog-query'

function pair(overrides: Partial<CatalogPair['listing']> = {}): CatalogPair {
  return {
    raw: {},
    listing: {
      id: 'prod_1',
      title: 'Zine de prueba',
      price_cents: 10000,
      status: 'active',
      manage_inventory: true,
      allow_backorder: false,
      in_stock: true,
      available_quantity: 5,
      reserved_quantity: 0,
      ...overrides,
    } as CatalogPair['listing'],
  }
}

describe('computeBulkDiff · price_set', () => {
  it('produces a valid patch for a positive integer price', () => {
    const result = computeBulkDiff(pair(), { type: 'price_set', price_cents: 5000 })
    expect(result.valid).toBe(true)
    expect(result.patch).toEqual({ price_cents: 5000 })
    expect(result.error).toBeNull()
  })

  it('rejects a price of $0 or less (price floor)', () => {
    const result = computeBulkDiff(pair(), { type: 'price_set', price_cents: 0 })
    expect(result.valid).toBe(false)
    expect(result.patch).toBeNull()
    expect(result.error).toMatch(/mayor a \$0/)
  })

  it('rejects a non-integer price', () => {
    const result = computeBulkDiff(pair(), { type: 'price_set', price_cents: 100.5 })
    expect(result.valid).toBe(false)
  })
})

describe('computeBulkDiff · price_pct', () => {
  it('computes the resulting price from the current price', () => {
    const result = computeBulkDiff(pair({ price_cents: 10000 }), { type: 'price_pct', percent: 10 })
    expect(result.valid).toBe(true)
    expect(result.patch).toEqual({ price_cents: 11000 })
  })

  it('supports a negative percent', () => {
    const result = computeBulkDiff(pair({ price_cents: 10000 }), { type: 'price_pct', percent: -50 })
    expect(result.patch).toEqual({ price_cents: 5000 })
  })

  it('rejects when the product has no fixed price ("precio a convenir")', () => {
    const result = computeBulkDiff(pair({ price_cents: null }), { type: 'price_pct', percent: 10 })
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/precio fijo/)
  })

  it('rejects when the resulting price would be $0 or less', () => {
    const result = computeBulkDiff(pair({ price_cents: 100 }), { type: 'price_pct', percent: -100 })
    expect(result.valid).toBe(false)
  })
})

describe('computeBulkDiff · pause_activate', () => {
  it('pausing an active listing sets status:draft + metadata.paused:true', () => {
    const result = computeBulkDiff(pair({ status: 'active' }), { type: 'pause_activate', status: 'paused' })
    expect(result.valid).toBe(true)
    expect(result.patch).toEqual({ status: 'draft', metadata: { paused: true } })
  })

  it('activating a paused listing sets status:published + metadata.paused:false', () => {
    const result = computeBulkDiff(pair({ status: 'paused' }), { type: 'pause_activate', status: 'active' })
    expect(result.valid).toBe(true)
    expect(result.patch).toEqual({ status: 'published', metadata: { paused: false } })
  })

  it('is a no-op error when the listing is already in the target state', () => {
    const result = computeBulkDiff(pair({ status: 'paused' }), { type: 'pause_activate', status: 'paused' })
    expect(result.valid).toBe(false)
    expect(result.patch).toBeNull()
    expect(result.error).toMatch(/Ya está pausado/)
  })
})
