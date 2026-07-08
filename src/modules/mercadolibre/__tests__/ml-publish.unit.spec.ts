import {
  buildMlItemPayload,
  decidePublishAction,
  mlSiteForCountry,
  type MlPublishInput,
} from '../_utils'

/**
 * Mercado Libre module · Sprint 3 pure publish helpers (the deterministic backend
 * gate). No DB, no network. Proves: the Medusa product → ML payload build incl.
 * graceful degradation + price/condition/quantity normalisation (US-7), the
 * reconcile action decision (US-7 + US-8), and the country → ML site map (US-9).
 */

function makeInput(overrides: Partial<MlPublishInput> = {}): MlPublishInput {
  return {
    title: 'Taladro inalámbrico 20V',
    price_cents: 185000, // $1,850.00
    currency: 'MXN',
    description: 'Taladro con dos baterías y maletín.',
    condition: 'new',
    available_quantity: 4,
    images: [{ url: 'https://http2.mlstatic.com/a.jpg' }, { url: 'https://http2.mlstatic.com/b.jpg' }],
    ...overrides,
  }
}

describe('buildMlItemPayload', () => {
  it('maps a full product into the ML item payload (cents → pesos, pictures as {source})', () => {
    const p = buildMlItemPayload(makeInput(), { categoryId: 'MLM1234' })
    expect(p.title).toBe('Taladro inalámbrico 20V')
    expect(p.category_id).toBe('MLM1234')
    expect(p.price).toBe(1850) // 185000 cents → 1850 pesos
    expect(p.currency_id).toBe('MXN')
    expect(p.available_quantity).toBe(4)
    expect(p.buying_mode).toBe('buy_it_now')
    expect(p.condition).toBe('new')
    expect(p.listing_type_id).toBe('bronze') // ML_DEFAULT_LISTING_TYPE
    expect(p.description).toEqual({ plain_text: 'Taladro con dos baterías y maletín.' })
    expect(p.pictures).toEqual([
      { source: 'https://http2.mlstatic.com/a.jpg' },
      { source: 'https://http2.mlstatic.com/b.jpg' },
    ])
  })

  it('degrades missing/odd fields (no throw): null price → 0, null qty → 1, used fallback, no pics/desc', () => {
    const p = buildMlItemPayload(
      { title: '  ', price_cents: null, currency: '', description: '', condition: 'good', available_quantity: null, images: [] },
      { categoryId: 'MLM1' },
    )
    expect(p.title).toBe('')
    expect(p.price).toBe(0)
    expect(p.currency_id).toBe('MXN') // empty currency → default
    expect(p.available_quantity).toBe(1) // null → clamp ≥1 (ML rejects 0 active)
    expect(p.condition).toBe('used') // anything not 'new' → used
    expect(p.description).toBeUndefined()
    expect(p.pictures).toBeUndefined()
  })

  it('clamps a 0/negative quantity to 1 and honours an override listing type', () => {
    expect(buildMlItemPayload(makeInput({ available_quantity: 0 }), { categoryId: 'C' }).available_quantity).toBe(1)
    expect(buildMlItemPayload(makeInput({ available_quantity: -5 }), { categoryId: 'C' }).available_quantity).toBe(1)
    expect(
      buildMlItemPayload(makeInput(), { categoryId: 'C', listingTypeId: 'gold_special' }).listing_type_id,
    ).toBe('gold_special')
  })
})

describe('decidePublishAction', () => {
  it('not linked → create', () => {
    expect(decidePublishAction({ linked: false, productPublished: true })).toBe('create')
    expect(decidePublishAction({ linked: false, productPublished: false })).toBe('create')
  })
  it('linked + Miyagi active + ML active → update', () => {
    expect(decidePublishAction({ linked: true, mlStatus: 'active', productPublished: true })).toBe('update')
  })
  it('linked + Miyagi archived/draft → close (unless already closed → noop)', () => {
    expect(decidePublishAction({ linked: true, mlStatus: 'active', productPublished: false })).toBe('close')
    expect(decidePublishAction({ linked: true, mlStatus: 'closed', productPublished: false })).toBe('noop')
  })
  it('linked + ML closed + Miyagi active → relist', () => {
    expect(decidePublishAction({ linked: true, mlStatus: 'closed', productPublished: true })).toBe('relist')
  })

  // catalog-management epic, Sprint 2 · Story 2.2 — the new per-product
  // mlEnabled toggle, independent of Miyagi's own publish state.
  it('not linked + mlEnabled:false → noop (toggled off before ever publishing, not an error)', () => {
    expect(decidePublishAction({ linked: false, productPublished: true, mlEnabled: false })).toBe('noop')
    expect(decidePublishAction({ linked: false, productPublished: false, mlEnabled: false })).toBe('noop')
  })
  it('linked + Miyagi active + mlEnabled:false → close (the toggle alone can close it)', () => {
    expect(decidePublishAction({ linked: true, mlStatus: 'active', productPublished: true, mlEnabled: false })).toBe('close')
  })
  it('linked + Miyagi PAUSED (productPublished:false) always force-closes regardless of mlEnabled:true', () => {
    expect(decidePublishAction({ linked: true, mlStatus: 'active', productPublished: false, mlEnabled: true })).toBe('close')
  })
  it('linked + already closed + mlEnabled:false stays noop (not relist)', () => {
    expect(decidePublishAction({ linked: true, mlStatus: 'closed', productPublished: true, mlEnabled: false })).toBe('noop')
  })
  it('linked + Miyagi active + mlEnabled:true (explicit) + ML closed → relist, same as mlEnabled omitted', () => {
    expect(decidePublishAction({ linked: true, mlStatus: 'closed', productPublished: true, mlEnabled: true })).toBe('relist')
  })
})

describe('mlSiteForCountry', () => {
  it('maps MX → MLM and defaults unknown to MLM', () => {
    expect(mlSiteForCountry('MX')).toBe('MLM')
    expect(mlSiteForCountry('mx')).toBe('MLM')
    expect(mlSiteForCountry('AR')).toBe('MLA')
    expect(mlSiteForCountry(null)).toBe('MLM')
    expect(mlSiteForCountry('ZZ')).toBe('MLM')
  })
})
