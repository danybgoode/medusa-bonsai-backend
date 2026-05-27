import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'

// GET /store/sellers/:slug — public seller profile
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const { slug } = req.params

  const [seller] = await sellerService.listSellers({ slug })

  if (!seller) {
    return res.status(404).json({ message: `Seller '${slug}' not found` })
  }

  res.json({ seller })
}
