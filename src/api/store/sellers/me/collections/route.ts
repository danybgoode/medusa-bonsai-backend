/**
 * GET  /store/sellers/me/collections — list the current seller's collections (ordered)
 * POST /store/sellers/me/collections — create a collection
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'
import { extractClerkUserId } from '../../../_utils/clerk-auth'
import { listSellerCollections, createSellerCollection } from '../../../_utils/seller-collections'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return res.status(401).json({ message: 'Authentication required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (!seller) return res.status(404).json({ message: 'No seller profile found.' })

  const collections = await listSellerCollections(req.scope, seller.id)
  res.json({ collections })
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return res.status(401).json({ message: 'Authentication required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (!seller) return res.status(404).json({ message: 'No seller profile found.' })

  const body = (req.body ?? {}) as { name?: string }
  const result = await createSellerCollection(req.scope, seller.id, seller.slug, body.name ?? '')
  if (!result.ok) return res.status(result.status).json({ message: result.message })

  res.status(201).json({ collection: result.collection })
}
