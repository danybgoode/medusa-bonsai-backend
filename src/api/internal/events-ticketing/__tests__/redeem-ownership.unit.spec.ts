import { resolveRedeemSellerOwnership } from '../redeem/route'

function fakeScope(links: Record<string, string[]>) {
  const graph = jest.fn(async (query: any) => {
    const sellerId = query.filters?.id as string
    return {
      data: [{
        id: sellerId,
        products: (links[sellerId] ?? []).map((id) => ({ id })),
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
  /**
   * This suite used to assert that a SOFT-DELETED event product could still be
   * redeemed, by faking a `graph` that returned the deleted row only when handed
   * `context: { products: QueryContext({}) } + withDeleted`. That request shape is not
   * one Medusa accepts — every real call threw `Trying to query by not existing
   * property Product.context`, and this route has no catch, so redemption 500'd rather
   * than "accepting a deleted product" (found 2026-08-15). The fake was the only place
   * the behaviour ever existed.
   *
   * Redeeming against a soft-deleted product is therefore a KNOWN GAP, not a feature
   * that regressed — tracked with the same gap on the seller-order surfaces.
   */
  it('accepts the seller linked to the event product and rejects another seller', async () => {
    const { scope, graph } = fakeScope({
      seller_owner: ['prod_event'],
      seller_other: ['prod_other'],
    })

    await expect(resolveRedeemSellerOwnership(
      scope,
      'seller_owner',
      'prod_event',
    )).resolves.toBe(true)
    await expect(resolveRedeemSellerOwnership(
      scope,
      'seller_other',
      'prod_event',
    )).resolves.toBe(false)

    expect(graph).toHaveBeenCalledTimes(2)
  })

  it('rejects a ticket with no resolvable historical product id', async () => {
    const { scope, graph } = fakeScope({ seller_owner: ['prod_event'] })

    await expect(resolveRedeemSellerOwnership(scope, 'seller_owner', null)).resolves.toBe(false)
    expect(graph).not.toHaveBeenCalled()
  })
})
