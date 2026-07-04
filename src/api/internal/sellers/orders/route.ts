/**
 * Internal service route — read a seller's orders on behalf of the seller's
 * MCP agent (ml-orders-native S3 · US-9). The agent has no Clerk JWT (it
 * authenticates via a separate `ms_agent_…` bearer token resolved against
 * Supabase, not this backend's Seller module), so the Next.js frontend (which
 * holds the shared secret and has already resolved the agent token → shop)
 * calls this with the shop slug instead. Mirrors
 * `internal/seller-products/[id]/route.ts`'s exact auth shape.
 *
 *   GET /internal/sellers/orders?seller_slug=<slug>
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { listOrdersForSeller } from '../../../store/sellers/me/orders/route'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const slug = req.query.seller_slug as string | undefined
  if (!slug) return res.status(400).json({ message: 'seller_slug required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const orders = await listOrdersForSeller(req.scope, seller.id, seller.name)
  res.json({ orders, seller_id: seller.id })
}
