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
 *   DELETE /internal/seller-products/:id?seller_slug=…   (body fallback accepted)
 *   Native Medusa soft-delete (mcp-parity-core S3.1) — the exact same call the
 *   Clerk-authenticated portal DELETE runs (store/sellers/me/products/:id): the
 *   row keeps `deleted_at` so past order line-items still resolve, which is why
 *   deleting an order-linked listing is safe by design (there is deliberately
 *   NO order-linked refusal guard anywhere on this path — parity, not policy).
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET (same as other
 * /internal routes). Ownership is double-checked here (seller-by-slug owns the
 * product) before the shared updateSellerProduct logic runs.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { IProductModuleService } from '@medusajs/framework/types'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { updateSellerProduct, type SellerProductUpdateBody } from '../../../store/_utils/seller-product-update'
import { resolveSellerProductIds } from '../../../store/_utils/seller-catalog-query'

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

  // Defense in depth: confirm the product belongs to this seller. Shares
  // resolveSellerProductIds() with the store-facing ownership check (see its
  // doc comment) — guards against the same null-array-slot crash right after
  // a soft-delete that broke this route's inline query pre-fix.
  const productIds = await resolveSellerProductIds(req.scope, seller.id)
  if (!productIds.has(id)) {
    return res.status(403).json({ message: 'Product not found in this shop' })
  }

  const result = await updateSellerProduct(req.scope, id, body, { id: seller.id, slug: seller.slug })
  if (!result.ok) return res.status(result.status).json({ message: result.message })

  res.json({ product_id: id, updated: true, ...(result.images ? { images: result.images } : {}) })
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { id } = req.params
  // Query param preferred (a DELETE body can be dropped by intermediaries);
  // body accepted as a fallback for symmetry with PATCH.
  const querySlug = typeof req.query?.seller_slug === 'string' ? req.query.seller_slug : undefined
  const bodySlug = ((req.body ?? {}) as { seller_slug?: string }).seller_slug
  const slug = querySlug || bodySlug
  if (!slug) return res.status(400).json({ message: 'seller_slug required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const productIds = await resolveSellerProductIds(req.scope, seller.id)
  if (!productIds.has(id)) {
    return res.status(403).json({ message: 'Product not found in this shop' })
  }

  // Same native soft-delete as the portal DELETE (store/sellers/me/products/:id)
  // — see that route's doc comment for why soft-delete (never a status hack) is
  // the single source of truth for "deleted" (LEARNINGS → Medusa gotchas).
  const productService: IProductModuleService = req.scope.resolve(Modules.PRODUCT)
  await productService.softDeleteProducts([id])

  res.json({ product_id: id, deleted: true })
}
