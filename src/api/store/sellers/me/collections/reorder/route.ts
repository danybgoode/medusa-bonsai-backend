/**
 * PATCH /store/sellers/me/collections/reorder — batch-write sort_order for
 * every collection this seller owns, one round trip for a drag-reorder UI.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../../modules/seller'
import SellerModuleService from '../../../../../../modules/seller/service'
import { extractClerkUserId } from '../../../../_utils/clerk-auth'
import { reorderSellerCollections } from '../../../../_utils/seller-collections'

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return res.status(401).json({ message: 'Authentication required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (!seller) return res.status(404).json({ message: 'No seller profile found.' })

  const body = (req.body ?? {}) as { order?: unknown }
  const order = Array.isArray(body.order) ? body.order.filter((x): x is string => typeof x === 'string') : null
  if (!order) return res.status(400).json({ message: 'order debe ser un arreglo de ids.' })

  const result = await reorderSellerCollections(req.scope, seller.id, order)
  if (!result.ok) return res.status(result.status).json({ message: result.message })

  res.status(200).json({ ok: true })
}
