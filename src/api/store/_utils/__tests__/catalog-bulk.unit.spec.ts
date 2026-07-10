import { computeBulkDiff, rejectOrchestrationOnlyPatch } from '../catalog-bulk'
import type { CatalogPair } from '../seller-catalog-query'

function pair(
  overrides: Partial<CatalogPair['listing']> = {},
  opts: { mlLinked?: boolean; raw?: Record<string, unknown> } = {},
): CatalogPair {
  return {
    raw: opts.raw ?? {},
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
      category: null,
      collections: [],
      ...overrides,
    } as CatalogPair['listing'],
    mlLinked: opts.mlLinked ?? false,
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

  it('rejects a non-finite percent (NaN/Infinity) rather than producing a NaN patch', () => {
    const nan = computeBulkDiff(pair({ price_cents: 10000 }), { type: 'price_pct', percent: NaN })
    expect(nan.valid).toBe(false)
    expect(nan.patch).toBeNull()
    const inf = computeBulkDiff(pair({ price_cents: 10000 }), { type: 'price_pct', percent: Infinity })
    expect(inf.valid).toBe(false)
    expect(inf.patch).toBeNull()
  })

  it('rejects percent: 0 (a true no-op, matches the "distinct from 0" UI validation)', () => {
    const result = computeBulkDiff(pair({ price_cents: 10000 }), { type: 'price_pct', percent: 0 })
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

describe('computeBulkDiff · publish_channel', () => {
  it('turning ON the miyagi channel when it was hidden produces a valid patch', () => {
    const result = computeBulkDiff(pair({}, { raw: { metadata: { miyagi_visible: false } } }), {
      type: 'publish_channel', channel: 'miyagi', enabled: true,
    })
    expect(result.valid).toBe(true)
    expect(result.patch).toEqual({ miyagi_visible: true })
  })

  it('turning ON ml when already linked is a no-op error', () => {
    const result = computeBulkDiff(pair({}, { mlLinked: true }), { type: 'publish_channel', channel: 'ml', enabled: true })
    expect(result.valid).toBe(false)
  })

  it('turning OFF ml when linked produces ml_enabled:false', () => {
    const result = computeBulkDiff(pair({}, { mlLinked: true }), { type: 'publish_channel', channel: 'ml', enabled: false })
    expect(result.valid).toBe(true)
    expect(result.patch).toEqual({ ml_enabled: false })
  })
})

describe('computeBulkDiff · category', () => {
  it('produces a category_handle patch', () => {
    const result = computeBulkDiff(pair(), { type: 'category', category_handle: 'autos', category_label: 'Autos' })
    expect(result.valid).toBe(true)
    expect(result.patch).toEqual({ category_handle: 'autos' })
    expect(result.after).toEqual({ category: 'Autos' })
  })
})

describe('computeBulkDiff · collection_assign', () => {
  it('produces a collection_ids patch (full replacement)', () => {
    const result = computeBulkDiff(pair(), {
      type: 'collection_assign', collection_ids: ['col_1', 'col_2'], collection_labels: ['Zines', 'Die-cut'],
    })
    expect(result.valid).toBe(true)
    expect(result.patch).toEqual({ collection_ids: ['col_1', 'col_2'] })
    expect(result.after).toEqual({ collections: 'Zines, Die-cut' })
  })
})

describe('computeBulkDiff · inventory_mode', () => {
  it('tracked → unlimited produces a valid patch', () => {
    const result = computeBulkDiff(pair({ manage_inventory: true, allow_backorder: false }), {
      type: 'inventory_mode', mode: 'unlimited',
    })
    expect(result.valid).toBe(true)
    expect(result.patch).toEqual({ inventory_mode: 'unlimited' })
  })

  it('tracked → backorder includes dispatch_estimate', () => {
    const result = computeBulkDiff(pair({ manage_inventory: true, allow_backorder: false }), {
      type: 'inventory_mode', mode: 'backorder', dispatch_estimate: '1-3d',
    })
    expect(result.patch).toEqual({ inventory_mode: 'backorder', dispatch_estimate: '1-3d' })
  })

  it('is a no-op error when already in the target mode', () => {
    const result = computeBulkDiff(pair({ manage_inventory: false }), { type: 'inventory_mode', mode: 'unlimited' })
    expect(result.valid).toBe(false)
  })
})

describe('computeBulkDiff · delete', () => {
  it('is always valid with a null patch (special-cased by the apply layer)', () => {
    const result = computeBulkDiff(pair(), { type: 'delete' })
    expect(result.valid).toBe(true)
    expect(result.patch).toBeNull()
    expect(result.after).toEqual({ status: 'eliminado' })
  })
})

describe('computeBulkDiff · apply_suggested_price (S4 · 4.2)', () => {
  const singleVariantRaw = { variants: [{ id: 'variant_1' }] }
  const multiVariantRaw = { variants: [{ id: 'variant_1' }, { id: 'variant_2' }] }

  it('produces a valid patch with variant_id + delta_cents for a single-variant product', () => {
    const result = computeBulkDiff(
      pair({ price_cents: 10000 }, { raw: singleVariantRaw }),
      { type: 'apply_suggested_price', target_margin_pct: 0.25, items: [{ id: 'prod_1', price_cents: 12000 }] },
    )
    expect(result.valid).toBe(true)
    expect(result.patch).toEqual({ variant_id: 'variant_1', price_cents: 12000 })
    expect(result.delta_cents).toBe(2000)
  })

  it('rejects a multi-variant product — price_cents is a min-across-variants synthetic, not a real single price', () => {
    const result = computeBulkDiff(
      pair({ price_cents: 10000 }, { raw: multiVariantRaw }),
      { type: 'apply_suggested_price', target_margin_pct: 0.25, items: [{ id: 'prod_1', price_cents: 12000 }] },
    )
    expect(result.valid).toBe(false)
    expect(result.patch).toBeNull()
    expect(result.error).toMatch(/varias variantes/)
  })

  it('rejects a product with no matching item in the action payload', () => {
    const result = computeBulkDiff(
      pair({ price_cents: 10000 }, { raw: singleVariantRaw }),
      { type: 'apply_suggested_price', target_margin_pct: 0.25, items: [{ id: 'prod_OTHER', price_cents: 12000 }] },
    )
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/precio sugerido/)
  })

  it('rejects a non-positive or non-integer suggested price', () => {
    const zero = computeBulkDiff(
      pair({ price_cents: 10000 }, { raw: singleVariantRaw }),
      { type: 'apply_suggested_price', target_margin_pct: 0.25, items: [{ id: 'prod_1', price_cents: 0 }] },
    )
    expect(zero.valid).toBe(false)
    const fractional = computeBulkDiff(
      pair({ price_cents: 10000 }, { raw: singleVariantRaw }),
      { type: 'apply_suggested_price', target_margin_pct: 0.25, items: [{ id: 'prod_1', price_cents: 100.5 }] },
    )
    expect(fractional.valid).toBe(false)
  })

  it('delta_cents is null when the product has no fixed current price', () => {
    const result = computeBulkDiff(
      pair({ price_cents: null }, { raw: singleVariantRaw }),
      { type: 'apply_suggested_price', target_margin_pct: 0.25, items: [{ id: 'prod_1', price_cents: 12000 }] },
    )
    expect(result.valid).toBe(true)
    expect(result.delta_cents).toBeNull()
  })
})

describe('rejectOrchestrationOnlyPatch', () => {
  it('rejects a null patch (delete signal)', () => {
    expect(rejectOrchestrationOnlyPatch(null)).not.toBeNull()
  })

  it('rejects a patch with ml_enabled set (ML-channel-toggle signal — needs toggleMlChannel)', () => {
    expect(rejectOrchestrationOnlyPatch({ ml_enabled: true })).not.toBeNull()
    expect(rejectOrchestrationOnlyPatch({ ml_enabled: false })).not.toBeNull()
  })

  it('rejects a patch with metadata.paused set (pause_activate signal — needs setListingStatus)', () => {
    expect(rejectOrchestrationOnlyPatch({ status: 'draft', metadata: { paused: true } })).not.toBeNull()
  })

  it('rejects a patch with variant_id + price_cents together (apply_suggested_price signal — needs the profit-analyzer apply-price flow, S4 · 4.2)', () => {
    expect(rejectOrchestrationOnlyPatch({ variant_id: 'variant_1', price_cents: 12000 })).not.toBeNull()
  })

  it('allows a plain field-patch (price/category/collection/inventory-mode) through', () => {
    expect(rejectOrchestrationOnlyPatch({ price_cents: 5000 })).toBeNull()
    expect(rejectOrchestrationOnlyPatch({ category_handle: 'autos' })).toBeNull()
    expect(rejectOrchestrationOnlyPatch({ collection_ids: ['col_1'] })).toBeNull()
    expect(rejectOrchestrationOnlyPatch({ inventory_mode: 'unlimited' })).toBeNull()
  })

  it('allows a metadata patch that is NOT the paused signal (e.g. custom_fields)', () => {
    expect(rejectOrchestrationOnlyPatch({ metadata: { custom_fields: {} } })).toBeNull()
  })

  it('allows a plain variant_id patch alone (e.g. a future variant-scoped action with no price_cents)', () => {
    expect(rejectOrchestrationOnlyPatch({ variant_id: 'variant_1' })).toBeNull()
  })
})
