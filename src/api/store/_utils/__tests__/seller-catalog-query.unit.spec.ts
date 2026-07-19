import {
  resolveSellerProductIds,
  resolveSellerProductMetadataRecords,
  sellerOwnsEveryOrderItem,
} from '../seller-catalog-query'

function fakeScope(products: Array<{ id: string } | null | undefined>) {
  const graph = jest.fn(async () => ({ data: [{ id: 'seller_1', products }] }))
  return {
    scope: {
      resolve: jest.fn(() => ({ graph })),
    },
    graph,
  }
}

describe('resolveSellerProductIds', () => {
  it('returns all ids when every linked product resolves', async () => {
    const { scope } = fakeScope([{ id: 'prod_1' }, { id: 'prod_2' }])
    const ids = await resolveSellerProductIds(scope, 'seller_1')
    expect(ids).toEqual(new Set(['prod_1', 'prod_2']))
  })

  // Regression: a live production incident (catalog-management S3 smoke) —
  // remoteQuery's seller→products link returns a sparse/null array slot for
  // a product whose deleted_at was just set by softDeleteProducts(), and a
  // bare .map((p) => p.id) crashed the very next catalog fetch after ANY
  // soft-delete, breaking the seller's whole Catálogo page in prod.
  it('filters out null/undefined slots left by a just-soft-deleted product', async () => {
    const { scope } = fakeScope([{ id: 'prod_1' }, null, { id: 'prod_3' }, undefined])
    const ids = await resolveSellerProductIds(scope, 'seller_1')
    expect(ids).toEqual(new Set(['prod_1', 'prod_3']))
  })

  it('returns an empty set when the seller has no linked products', async () => {
    const { scope } = fakeScope([])
    const ids = await resolveSellerProductIds(scope, 'seller_1')
    expect(ids).toEqual(new Set())
  })

  it('puts withDeleted on the nested products relation for order ownership', async () => {
    const { scope, graph } = fakeScope([{ id: 'prod_live' }, { id: 'prod_deleted' }])

    const ids = await resolveSellerProductIds(scope, 'seller_1', { includeDeleted: true })

    expect(ids).toEqual(new Set(['prod_live', 'prod_deleted']))
    expect(graph).toHaveBeenCalledWith({
      entity: 'seller',
      fields: ['id', 'products.id'],
      filters: { id: 'seller_1' },
      context: {
        products: {
          __type: 'QueryContext',
        },
      },
      withDeleted: true,
    })
  })

  it('keeps live catalog reads on Medusa default soft-delete filtering', async () => {
    const { scope, graph } = fakeScope([{ id: 'prod_live' }])

    await resolveSellerProductIds(scope, 'seller_1')

    expect(graph).toHaveBeenCalledWith({
      entity: 'seller',
      fields: ['id', 'products.id'],
      filters: { id: 'seller_1' },
    })
  })
})

describe('resolveSellerProductMetadataRecords', () => {
  it('filters sparse relation slots before metadata consumers find or iterate', async () => {
    const graph = jest.fn(async () => ({
      data: [{
        id: 'seller_1',
        products: [
          { id: 'prod_1', metadata: { views: 3 } },
          null,
          undefined,
          { id: 'prod_2', metadata: { views: 5 } },
        ],
      }],
    }))

    const products = await resolveSellerProductMetadataRecords({ graph }, 'seller_1')

    expect(products).toEqual([
      { id: 'prod_1', metadata: { views: 3 } },
      { id: 'prod_2', metadata: { views: 5 } },
    ])
  })
})

describe('sellerOwnsEveryOrderItem', () => {
  const owned = new Set(['prod_1', 'prod_2'])

  it('authorizes only when every order item has a resolvable owned product id', () => {
    expect(sellerOwnsEveryOrderItem(owned, [
      { product_id: 'prod_1' },
      { product_id: 'prod_2' },
    ])).toBe(true)
  })

  it.each([
    ['zero items', []],
    ['a missing product id', [{ product_id: 'prod_1' }, {}]],
    ['an explicit null product id', [{ product_id: 'prod_1' }, { product_id: null }]],
    ['partial ownership', [{ product_id: 'prod_1' }, { product_id: 'prod_other' }]],
  ])('fails closed for %s', (_case, items) => {
    expect(sellerOwnsEveryOrderItem(owned, items)).toBe(false)
  })

  it('fails closed when the seller-owned set is empty', () => {
    expect(sellerOwnsEveryOrderItem(new Set(), [{ product_id: 'prod_1' }])).toBe(false)
  })
})
