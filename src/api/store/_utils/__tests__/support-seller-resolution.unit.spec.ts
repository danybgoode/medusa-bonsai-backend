import { resolveSellerForCheckout } from '../support-seller-resolution'

function sellerServiceWith(sellers: Array<{ id: string }>) {
  return {
    listSellers: jest.fn(async (filters?: Record<string, unknown>) => {
      if (filters?.id) return sellers.filter((seller) => seller.id === filters.id)
      return sellers
    }),
  }
}

function remoteQueryWithLinks(links: Record<string, string[]>) {
  return jest.fn(async (query: { seller: { variables: { filters: { id: string } } } }) => {
    const sellerId = query.seller.variables.filters.id
    return {
      data: [{
        id: sellerId,
        products: (links[sellerId] ?? []).map((id) => ({ id })),
      }],
    }
  })
}

describe('resolveSellerForCheckout', () => {
  it('uses support product metadata before a stale caller seller id', async () => {
    const sellerService = sellerServiceWith([{ id: 'seller_support' }, { id: 'seller_stale' }])
    const remoteQuery = remoteQueryWithLinks({})

    await expect(resolveSellerForCheckout({
      sellerService,
      remoteQuery,
      productId: 'prod_support',
      bodySellerId: 'seller_stale',
      productMetadata: { support_seller_id: 'seller_support' },
      isSupportCheckout: true,
    })).resolves.toMatchObject({ id: 'seller_support' })
  })

  it('falls back to the Medusa product link when caller seller id is from the wrong domain', async () => {
    const sellerService = sellerServiceWith([{ id: 'seller_real' }])
    const remoteQuery = remoteQueryWithLinks({ seller_real: ['prod_support'] })

    await expect(resolveSellerForCheckout({
      sellerService,
      remoteQuery,
      productId: 'prod_support',
      bodySellerId: 'supabase_shop_id',
      productMetadata: {},
      isSupportCheckout: true,
    })).resolves.toMatchObject({ id: 'seller_real' })
  })

  it('keeps the fast path for a valid Medusa seller id', async () => {
    const sellerService = sellerServiceWith([{ id: 'seller_fast' }])
    const remoteQuery = remoteQueryWithLinks({})

    await expect(resolveSellerForCheckout({
      sellerService,
      remoteQuery,
      productId: 'prod_ordinary',
      bodySellerId: 'seller_fast',
      productMetadata: {},
      isSupportCheckout: false,
    })).resolves.toMatchObject({ id: 'seller_fast' })
  })
})
