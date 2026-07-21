/**
 * Internal service route — read a seller's DRAFT products, Medusa-authoritative.
 *
 *   GET /internal/seller-products/drafts?seller_slug=<slug>
 *
 * Founding merchant consent-safe previews (frontend epic 08). The merchant's
 * private preview shows exactly the products a promoter proposed, which live as
 * native Medusa `status:'draft'` products. The frontend previously read them from
 * the Supabase mirror because no Medusa read seam exposed drafts (every public
 * /store/* route filters `status:'published'`). Per the Sprint-1 review decision
 * (Daniel, 2026-07-21) the consent surface must read the AUTHORITATIVE Medusa
 * copy, not a mirror that can drift — so this route exposes exactly that, behind
 * the shared internal secret.
 *
 * It returns the SAME shape the published catalog uses (`toListingShape`), so the
 * proposal the merchant reviews is byte-for-byte what activation will publish.
 * Auth: `x-internal-secret` must match `MEDUSA_INTERNAL_SECRET` (same gate as the
 * sibling POST/PATCH internal routes). Only the Next.js server holds that secret,
 * and it has already resolved + authorized the promoter → shop before calling.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { isHiddenCatalogProduct } from '../../../store/_utils/support'
import { toListingShape } from '../../../store/_utils/listing'
import { resolveSellerProductIds } from '../../../store/_utils/seller-catalog-query'

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
  if (!seller) return res.status(404).json({ message: `Seller '${slug}' not found` })

  const linkedIdSet = await resolveSellerProductIds(req.scope, seller.id)
  const linkedIds = [...linkedIdSet]
  if (linkedIds.length === 0) {
    return res.json({ seller, products: [], count: 0 })
  }

  const remoteQuery = req.scope.resolve('remoteQuery')
  const { data: allProducts } = await remoteQuery.graph({
    entity: 'product',
    fields: [
      'id', 'title', 'description', 'status', 'metadata', 'created_at',
      'variants.*', 'variants.prices.*',
      'images.*',
      'categories.*',
      'type.*',
      'tags.*',
    ],
    // Filter by THIS seller's linked ids (not a global draft scan) so a system-wide
    // draft count above any page size can never truncate a seller's proposal —
    // the published seller-products route's in-memory intersection has that latent
    // cap; scoping the query removes it here.
    filters: { id: linkedIds, status: 'draft' },
    pagination: { take: linkedIds.length, skip: 0 },
  })

  const products = (allProducts ?? [])
    // A paused live listing is also Medusa `status:'draft'` (metadata.paused);
    // it is NOT part of a preview proposal, so exclude it — only genuinely
    // unpublished proposal products belong here.
    .filter((product: { metadata?: Record<string, unknown> | null }) => product.metadata?.paused !== true)
    .filter((product: { metadata?: unknown }) => !isHiddenCatalogProduct(product.metadata))
    .sort((a: { created_at?: string | Date }, b: { created_at?: string | Date }) =>
      new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())
    .map((product: unknown) => toListingShape(product, seller))

  res.json({ seller, products, count: products.length })
}
