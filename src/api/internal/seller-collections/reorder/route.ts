/**
 * Internal service route — reorder a seller's collections on behalf of the
 * seller's MCP agent (mcp-parity-config · Sprint 1). Same auth + resolution
 * shape as the sibling /internal/seller-collections routes; the mutation is
 * the same reorderSellerCollections the Clerk-authed store route
 * (store/sellers/me/collections/reorder) already runs — including its
 * full-set guard (every owned collection exactly once, foreign ids rejected).
 *
 *   POST /internal/seller-collections/reorder
 *        body: { seller_slug, ordered_ids: string[] }
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { reorderSellerCollections } from '../../../store/_utils/seller-collections'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const body = (req.body ?? {}) as { seller_slug?: string; ordered_ids?: unknown }
  if (!body.seller_slug) return res.status(400).json({ message: 'seller_slug required' })
  if (!Array.isArray(body.ordered_ids) || body.ordered_ids.some((x) => typeof x !== 'string')) {
    return res.status(400).json({ message: 'ordered_ids must be an array of collection ids' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug: body.seller_slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const result = await reorderSellerCollections(req.scope, seller.id, body.ordered_ids as string[])
  if (!result.ok) return res.status(result.status).json({ message: result.message })

  res.json({ ok: true })
}
