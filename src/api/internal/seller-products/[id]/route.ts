/**
 * Internal service route — update a seller's product on behalf of the seller's
 * MCP agent (Seller Agent Operations · Sprint 2). The agent has no Clerk JWT, so
 * the Next.js frontend (which holds the shared secret and has already resolved +
 * ownership-checked the agent token → shop) calls this with the shop slug.
 *
 *   PATCH /internal/seller-products/:id   body: { seller_slug, title?, description?,
 *           price_cents?, quantity?, weight_grams?, status?, attrs?, metadata?,
 *           images?: [{ url, alt? }], images_mode?: 'append'|'replace' }
 *   On an image write the response echoes the final, de-duped { images } set.
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET (same as other
 * /internal routes). Ownership is double-checked here (seller-by-slug owns the
 * product) before the shared updateSellerProduct logic runs.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { updateSellerProduct, type SellerProductUpdateBody } from '../../../store/_utils/seller-product-update'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { id } = req.params
  const body = req.body as SellerProductUpdateBody & { seller_slug?: string }
  const slug = body.seller_slug
  if (!slug) return res.status(400).json({ message: 'seller_slug required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  // Defense in depth: confirm the product belongs to this seller.
  const remoteQuery = req.scope.resolve('remoteQuery')
  const { data: rows } = await remoteQuery.graph({
    entity: 'seller',
    fields: ['id', 'products.id'],
    filters: { id: seller.id },
  })
  const productIds = ((rows?.[0] as any)?.products ?? []).map((p: any) => p.id)
  if (!productIds.includes(id)) {
    return res.status(403).json({ message: 'Product not found in this shop' })
  }

  const result = await updateSellerProduct(req.scope, id, body)
  if (!result.ok) return res.status(result.status).json({ message: result.message })

  res.json({ product_id: id, updated: true, ...(result.images ? { images: result.images } : {}) })
}
