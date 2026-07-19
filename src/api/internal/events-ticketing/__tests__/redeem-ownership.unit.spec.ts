import { resolveRedeemSellerOwnership } from '../redeem/route'

function fakeScope(links: Record<string, string[]>) {
  const graph = jest.fn(async (query: any) => {
    const sellerId = query.filters?.id as string
    const nestedDeletedRead = query.withDeleted === true
      && query.context?.products?.__type === 'QueryContext'

    return {
      data: [{
        id: sellerId,
        // The historical product is only visible when the route genuinely
        // requests Medusa's deleted-inclusive nested relation.
        products: nestedDeletedRead
          ? (links[sellerId] ?? []).map((id) => ({ id }))
          : [null],
      }],
    }
  })

  return {
    scope: {
      resolve: jest.fn(() => ({ graph })),
    } as any,
    graph,
  }
}

describe('ticket redeem seller ownership', () => {
  it('accepts the seller linked to a deleted event product and rejects another seller', async () => {
    const { scope, graph } = fakeScope({
      seller_owner: ['prod_deleted_event'],
      seller_other: ['prod_other'],
    })

    await expect(resolveRedeemSellerOwnership(
      scope,
      'seller_owner',
      'prod_deleted_event',
    )).resolves.toBe(true)
    await expect(resolveRedeemSellerOwnership(
      scope,
      'seller_other',
      'prod_deleted_event',
    )).resolves.toBe(false)

    expect(graph).toHaveBeenCalledTimes(2)
  })

  it('rejects a ticket with no resolvable historical product id', async () => {
    const { scope, graph } = fakeScope({ seller_owner: ['prod_deleted_event'] })

    await expect(resolveRedeemSellerOwnership(scope, 'seller_owner', null)).resolves.toBe(false)
    expect(graph).not.toHaveBeenCalled()
  })
})
