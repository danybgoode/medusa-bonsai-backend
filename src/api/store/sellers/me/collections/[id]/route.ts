/**
 * PATCH  /store/sellers/me/collections/:id — rename a collection (handle never changes)
 * DELETE /store/sellers/me/collections/:id — delete a collection (never touches its products)
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../../modules/seller'
import SellerModuleService from '../../../../../../modules/seller/service'
import { extractClerkUserId } from '../../../../_utils/clerk-auth'
import { renameSellerCollection, deleteSellerCollection } from '../../../../_utils/seller-collections'

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return res.status(401).json({ message: 'Authentication required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (!seller) return res.status(404).json({ message: 'No seller profile found.' })

  const body = (req.body ?? {}) as { name?: string }
  const result = await renameSellerCollection(req.scope, seller.id, req.params.id, body.name ?? '')
  if (!result.ok) return res.status(result.status).json({ message: result.message })

  res.status(200).json({ ok: true })
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return res.status(401).json({ message: 'Authentication required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (!seller) return res.status(404).json({ message: 'No seller profile found.' })

  const result = await deleteSellerCollection(req.scope, seller.id, req.params.id)
  if (!result.ok) return res.status(result.status).json({ message: result.message })

  res.status(200).json({ ok: true })
}
