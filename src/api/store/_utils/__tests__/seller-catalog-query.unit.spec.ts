import { resolveSellerProductIds } from '../seller-catalog-query'

function fakeScope(products: Array<{ id: string } | null | undefined>) {
  return {
    resolve: jest.fn(() => ({
      graph: jest.fn(async () => ({ data: [{ id: 'seller_1', products }] })),
    })),
  }
}

describe('resolveSellerProductIds', () => {
  it('returns all ids when every linked product resolves', async () => {
    const scope = fakeScope([{ id: 'prod_1' }, { id: 'prod_2' }])
    const ids = await resolveSellerProductIds(scope, 'seller_1')
    expect(ids).toEqual(new Set(['prod_1', 'prod_2']))
  })

  // Regression: a live production incident (catalog-management S3 smoke) —
  // remoteQuery's seller→products link returns a sparse/null array slot for
  // a product whose deleted_at was just set by softDeleteProducts(), and a
  // bare .map((p) => p.id) crashed the very next catalog fetch after ANY
  // soft-delete, breaking the seller's whole Catálogo page in prod.
  it('filters out null/undefined slots left by a just-soft-deleted product', async () => {
    const scope = fakeScope([{ id: 'prod_1' }, null, { id: 'prod_3' }, undefined])
    const ids = await resolveSellerProductIds(scope, 'seller_1')
    expect(ids).toEqual(new Set(['prod_1', 'prod_3']))
  })

  it('returns an empty set when the seller has no linked products', async () => {
    const scope = fakeScope([])
    const ids = await resolveSellerProductIds(scope, 'seller_1')
    expect(ids).toEqual(new Set())
  })
})
