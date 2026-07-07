/**
 * GET /store/sellers/:slug/collections — a shop's collections (ordered), public
 * read for the storefront nav strip. No auth (mirrors sellers/[slug]/products).
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'
import { listSellerCollections } from '../../../_utils/seller-collections'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const { slug } = req.params

  const [seller] = await sellerService.listSellers({ slug })
  if (!seller) return res.status(404).json({ message: `Seller '${slug}' not found` })

  const collections = await listSellerCollections(req.scope, seller.id)
  res.json({ collections })
}
