import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { toSellerShape } from '../../_utils/listing'
import { sellerRowEnforcement } from '../../../../lib/seller-status'

// GET /store/sellers/:slug — public seller profile
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const { slug } = req.params

  const [seller] = await sellerService.listSellers({ slug })

  const visibility = sellerRowEnforcement(seller)
  if (!seller || !visibility.present || !visibility.admits) {
    return res.status(404).json({ message: `Seller '${slug}' not found` })
  }

  res.json({ seller: toSellerShape(seller) })
}
