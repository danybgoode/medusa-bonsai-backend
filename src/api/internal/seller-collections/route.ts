/**
 * Internal service route — create a collection on behalf of the seller's MCP
 * agent (panfleto-premium-shop · Sprint 2). The agent has no Clerk JWT, so
 * the Next.js frontend (which holds the shared secret and has already
 * resolved + validated the agent token → shop) calls this with the shop
 * slug. Mirrors internal/seller-products/route.ts's auth + seller-resolution
 * shape exactly; the actual creation logic is the same
 * `createSellerCollection` the Clerk-authed store route
 * (store/sellers/me/collections) already uses.
 *
 *   POST /internal/seller-collections   body: { seller_slug, name }
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'
import { createSellerCollection } from '../../store/_utils/seller-collections'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const body = req.body as { seller_slug?: string; name?: string }
  const slug = body.seller_slug
  if (!slug) return res.status(400).json({ message: 'seller_slug required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const result = await createSellerCollection(req.scope, seller.id, seller.slug, body.name ?? '')
  if (!result.ok) return res.status(result.status).json({ message: result.message })

  res.status(201).json({ collection: result.collection, seller_slug: seller.slug })
}
