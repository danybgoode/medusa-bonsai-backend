import { resolveSellerProductIdsFromRemoteQuery } from './seller-catalog-query'

type SellerServiceLike = {
  listSellers: (filters?: Record<string, unknown>, config?: Record<string, unknown>) => Promise<any[]>
}

export async function findSellerById(sellerService: SellerServiceLike, sellerId?: string | null) {
  if (!sellerId) return null
  const [seller] = await sellerService.listSellers({ id: sellerId }, { take: 1 })
  return seller ?? null
}

export async function findSellerLinkedToProduct(
  sellerService: SellerServiceLike,
  remoteQuery: any,
  productId?: string | null,
) {
  if (!productId) return null

  const allSellers = await sellerService.listSellers({}, { take: 500 })
  for (const seller of allSellers) {
    try {
      const ids = await resolveSellerProductIdsFromRemoteQuery(remoteQuery, seller.id)
      if (ids.has(productId)) return seller
    } catch {
      // no products linked
    }
  }

  return null
}

export function supportSellerIdFromMetadata(metadata: Record<string, unknown>) {
  const sellerId = metadata.support_seller_id
  return typeof sellerId === 'string' && sellerId ? sellerId : null
}

export async function resolveSellerForCheckout({
  sellerService,
  remoteQuery,
  productId,
  bodySellerId,
  productMetadata,
  isSupportCheckout,
}: {
  sellerService: SellerServiceLike
  remoteQuery: any
  productId?: string | null
  bodySellerId?: string | null
  productMetadata: Record<string, unknown>
  isSupportCheckout: boolean
}) {
  let seller = isSupportCheckout
    ? await findSellerById(sellerService, supportSellerIdFromMetadata(productMetadata))
    : null

  if (!seller && bodySellerId) {
    seller = await findSellerById(sellerService, bodySellerId)
  }

  if (!seller) {
    seller = await findSellerLinkedToProduct(sellerService, remoteQuery, productId)
  }

  return seller
}
