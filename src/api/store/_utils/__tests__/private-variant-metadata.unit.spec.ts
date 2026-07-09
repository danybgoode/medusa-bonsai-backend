/**
 * Seller-private variant metadata scrub (profit-analyzer S1 — reviewer catch):
 * the public `GET /store/sellers/:slug/products` returns RAW variants, so
 * `stripPrivateVariantMetadata` is what keeps the seller's COGS
 * (`unit_cost_cents`) and, since catalog-management epic Sprint 2 · Story 2.3,
 * the ML price override (`ml_price_cents`) out of public reads while public
 * keys (`disabled`) survive for the storefront's own filtering.
 */
import { stripPrivateVariantMetadata } from '../listing'

describe('stripPrivateVariantMetadata', () => {
  const product = {
    id: 'p1',
    variants: [
      { id: 'v1', metadata: { unit_cost_cents: 4500, ml_price_cents: 220000, disabled: true } },
      { id: 'v2', metadata: { disabled: false } },
      { id: 'v3', metadata: null },
      { id: 'v4' },
    ],
  }

  it('removes unit_cost_cents and ml_price_cents but keeps public keys like disabled', () => {
    const out = stripPrivateVariantMetadata(product)
    expect(out.variants![0].metadata).toEqual({ disabled: true })
    expect(out.variants![1].metadata).toEqual({ disabled: false })
    expect(out.variants![2].metadata).toBeNull()
    expect(out.variants![3].metadata).toBeUndefined()
  })

  it('never mutates the input rows', () => {
    stripPrivateVariantMetadata(product)
    expect(product.variants[0].metadata).toEqual({ unit_cost_cents: 4500, ml_price_cents: 220000, disabled: true })
  })

  it('passes through products without variants', () => {
    expect(stripPrivateVariantMetadata({ id: 'p2' } as { variants?: unknown[] })).toEqual({ id: 'p2' })
    expect(stripPrivateVariantMetadata({ id: 'p3', variants: [] }).variants).toEqual([])
  })
})
