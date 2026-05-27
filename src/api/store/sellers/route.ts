import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'

// GET /store/sellers — list sellers (paginated, for directory / discovery)
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)

  const limit = Math.min(parseInt(req.query.limit as string ?? '20'), 50)
  const offset = parseInt(req.query.offset as string ?? '0')

  const [sellers, count] = await sellerService.listAndCountSellers(
    { verified: true },
    { take: limit, skip: offset, order: { created_at: 'DESC' } }
  )

  res.json({ sellers, count, limit, offset })
}
