/**
 * Internal service route — provision (or reuse) a seller's hidden support
 * product on behalf of the seller's MCP agent (mcp-parity-core S4.1). The
 * agent has no Clerk JWT, so the Next.js frontend (which holds the shared
 * secret and has already resolved + ownership-checked the agent token → shop)
 * calls this with the shop slug — same service-to-service door as
 * /internal/seller-products and /internal/seller-collections.
 *
 *   POST /internal/support-product   body: { seller_slug }
 *   → { product_id, reused }
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET. Delegates to the
 * exact same reuse-first core the Clerk portal route uses
 * (_utils/support-product-ensure.ts), so an agent-provisioned support product
 * is indistinguishable from a portal-provisioned one.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'
import { ensureSupportProductForSeller } from '../../store/_utils/support-product-ensure'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  if (!expected || got !== expected) return res.status(401).json({ message: 'Unauthorized' })

  const { seller_slug: slug } = (req.body ?? {}) as { seller_slug?: string }
  if (!slug) return res.status(400).json({ message: 'seller_slug required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const result = await ensureSupportProductForSeller(req.scope, seller)
  if (!result.ok) return res.status(result.status).json({ message: result.message })

  return res.status(result.reused ? 200 : 201).json({ product_id: result.product_id, reused: result.reused })
}
