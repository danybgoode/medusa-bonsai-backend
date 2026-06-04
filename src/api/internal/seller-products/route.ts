/**
 * Internal service route — create a product on behalf of the seller's MCP agent
 * (Seller Agent Operations · Sprint 3). The agent has no Clerk JWT, so the
 * Next.js frontend (which holds the shared secret and has already resolved +
 * validated the agent token → shop) calls this with the shop slug.
 *
 *   POST /internal/seller-products   body: { seller_slug, title, category?, price_cents?,
 *           currency?, condition?, listing_type?, state?, municipio?, location?, quantity?,
 *           weight_grams?, status?, images?, attrs?, metadata? }
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET (same as the sibling
 * PATCH /internal/seller-products/:id route). The seller is resolved by slug and
 * the shared createSellerProduct logic (used by the Clerk-authed store route too)
 * runs against that seller.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'
import { createSellerProduct, type CreateProductBody } from '../../store/_utils/seller-product-create'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const body = req.body as CreateProductBody & { seller_slug?: string }
  const slug = body.seller_slug
  if (!slug) return res.status(400).json({ message: 'seller_slug required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const result = await createSellerProduct(req.scope, seller.id, body)
  if (!result.ok) return res.status(result.status).json({ message: result.message })

  res.status(201).json({ product_id: result.product_id, seller_slug: seller.slug })
}
