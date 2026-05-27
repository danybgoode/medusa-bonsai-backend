import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'

// PATCH /admin/sellers/:id — update seller (verify/unverify, name, etc.)
export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const { id } = req.params

  const body = req.body as {
    verified?: boolean
    name?: string
    description?: string
    location?: string
  }

  const updated = await sellerService.updateSellers({
    id,
    ...(body.verified !== undefined && { verified: body.verified }),
    ...(body.name !== undefined && { name: body.name }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.location !== undefined && { location: body.location }),
  })

  res.json({ seller: updated })
}
