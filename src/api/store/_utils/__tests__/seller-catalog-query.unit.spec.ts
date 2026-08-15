import {
  resolveSellerProductIds,
  resolveSellerProductIdsWithSlots,
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

  it('asks ONLY for the shape Medusa accepts — no context, no withDeleted', async () => {
    // This test used to assert the OPPOSITE, against a fake `graph` that accepts any
    // object: it pinned `context: { products: QueryContext({}) }` + `withDeleted: true`
    // and passed for months while every real call threw
    // `Trying to query by not existing property Product.context`. A spec that proves we
    // BUILT the payload we meant to build says nothing about whether the API takes it.
    const { scope, graph } = fakeScope([{ id: 'prod_live' }])

    await resolveSellerProductIds(scope, 'seller_1')

    expect(graph).toHaveBeenCalledWith({
      entity: 'seller',
      fields: ['id', 'products.id'],
      filters: { id: 'seller_1' },
    })
    const sent = (graph.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0]
    expect(sent).not.toHaveProperty('context')
    expect(sent).not.toHaveProperty('withDeleted')
  })

  it('the shape survives Medusa OWN translator — the check the old spec lacked', () => {
    // Runs the query through the installed `toRemoteQuery`, so an invented argument
    // shows up here instead of in production. The removed one emitted
    // `seller.products.__args.context`, which is precisely what is asserted absent.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { toRemoteQuery } = require('@medusajs/modules-sdk/dist/remote-query/to-remote-query.js')

    const built = toRemoteQuery(
      { entity: 'seller', fields: ['id', 'products.id'], filters: { id: 'seller_1' } },
      {},
    )
    expect(built.seller.products?.__args).toBeUndefined()

    // The negation, so this guard cannot pass by never seeing the bad shape.
    const broken = toRemoteQuery(
      {
        entity: 'seller',
        fields: ['id', 'products.id'],
        filters: { id: 'seller_1' },
        context: { products: { __type: 'QueryContext' } },
        withDeleted: true,
      },
      {},
    )
    expect(broken.seller.products.__args).toHaveProperty('context')
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

/**
 * The residual gap, measured. Removing `includeDeleted` means a soft-deleted linked
 * product is no longer in the seller's id set — so an order whose every item is one
 * of those stays invisible. That is a real, narrower gap than the outage it replaces
 * (every seller saw zero orders), and it must be a NUMBER, not an assumption.
 */
describe('resolveSellerProductIdsWithSlots', () => {
  it('counts the sparse slots a soft-delete leaves behind', async () => {
    const { scope } = fakeScope([{ id: 'prod_live' }, null, undefined, { id: 'prod_other' }])

    const resolved = await resolveSellerProductIdsWithSlots(scope, 'seller_1')

    expect(resolved.ids).toEqual(new Set(['prod_live', 'prod_other']))
    expect(resolved.unresolvedSlots).toBe(2)
  })

  it('reports ZERO when nothing is missing — not merely a falsy value', async () => {
    // `0` and "we did not look" must not read alike on the trace.
    const { scope } = fakeScope([{ id: 'prod_live' }])
    const resolved = await resolveSellerProductIdsWithSlots(scope, 'seller_1')
    expect(resolved.unresolvedSlots).toBe(0)
    expect(resolved.ids.size).toBe(1)
  })

  it('agrees with the plain resolver on the ids it returns', async () => {
    const slots = [{ id: 'a' }, null, { id: 'b' }]
    const plain = await resolveSellerProductIds(fakeScope(slots).scope, 'seller_1')
    const withSlots = await resolveSellerProductIdsWithSlots(fakeScope(slots).scope, 'seller_1')
    expect(withSlots.ids).toEqual(plain)
  })
})
