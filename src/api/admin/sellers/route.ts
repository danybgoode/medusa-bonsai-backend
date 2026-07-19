import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'
import { resolveSellerProductIds } from '../../store/_utils/seller-catalog-query'

// GET /admin/sellers — list all sellers with product counts
// Optional: ?product_id=X to find the seller that owns a specific product
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const productId = req.query.product_id as string | undefined

  const sellers = await sellerService.listSellers({}, { take: 1000, skip: 0 })

  // Enrich each seller with their product IDs via the link table
  const enriched = await Promise.all(
    sellers.map(async (seller) => {
      let productIds: string[] = []
      try {
        productIds = [...await resolveSellerProductIds(req.scope, seller.id)]
      } catch { /* no products linked */ }

      return {
        ...seller,
        product_count: productIds.length,
        product_ids: productIds,
        claimed: !!(seller.clerk_user_id && !String(seller.clerk_user_id).startsWith('pending:')),
      }
    })
  )

  // If filtering by product_id, return only the owning seller
  if (productId) {
    const owner = enriched.find(s => s.product_ids.includes(productId)) ?? null
    return res.json({ seller: owner })
  }

  // Sort: verified first, then claimed, then by created_at desc
  enriched.sort((a, b) => {
    if (a.verified !== b.verified) return b.verified ? 1 : -1
    if (a.claimed !== b.claimed) return b.claimed ? 1 : -1
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })

  res.json({ sellers: enriched, count: enriched.length })
}
