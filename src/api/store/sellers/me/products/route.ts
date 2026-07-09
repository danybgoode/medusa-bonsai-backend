import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'
import { extractClerkUserId } from '../../../_utils/clerk-auth'
import { createSellerProduct, type CreateProductBody } from '../../../_utils/seller-product-create'
import { querySellerCatalog, type CatalogFilterParams } from '../../../_utils/seller-catalog-query'

// GET /store/sellers/me/products — list all products for the authenticated seller
//
// Optional server-side filters for the catalog-management table (Sprint 1 ·
// Story 1.2), all additive — a request with none of these behaves exactly as
// before: `q` (title search), `status` (activo|agotado|borrador|pausado —
// the fine split catalog-status.ts on the frontend also derives), `category`
// (category handle), `channel` (miyagi|ml), `stock` (in_stock|agotado|unlimited),
// `sort` (recent|title|price_asc|price_desc).
//
// `id`, `title` search, and `categories.handle` are pushed down to the DB
// filter on the seller's linked products — real filtering, not "fetch
// everything then slice." `status` is deliberately NOT pushed to the DB: the
// per-state counts must reflect every status for whatever q/category/channel/
// stock filters are active, not just the currently-selected one, so the status
// split (native published/draft + the fine agotado/pausado distinction) stays
// in-memory alongside stock-state, the ML channel badge, and the hidden-catalog
// exclusion — all computed/cross-module concerns that run on this already
// seller-scoped, DB-narrowed batch (never the full store catalog) before the
// final offset/limit slice + count, so a page is never short a row. Pushing
// `id: linkedIds` down also fixes a latent bug
// in the old unconditional `pagination: { take: 2000, skip: 0 }` fetch: with
// no id filter, `remoteQuery.graph` pulled an unscoped global page of products
// and intersected with this seller's ids in JS — in a store with 2000+ total
// products across all sellers, some of THIS seller's own products could sort
// past that global page and silently vanish from their own list.
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) {
    return res.status(401).json({ message: 'Authentication required' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (!seller) {
    return res.status(404).json({ message: 'Seller profile not found' })
  }

  const limit = Math.min(parseInt(req.query.limit as string ?? '100'), 200)
  const offset = parseInt(req.query.offset as string ?? '0')
  const filters: CatalogFilterParams = {
    q: (req.query.q as string | undefined)?.trim() || undefined,
    category: (req.query.category as string | undefined)?.trim() || undefined,
    channel: req.query.channel as CatalogFilterParams['channel'],
    stock: req.query.stock as CatalogFilterParams['stock'],
    status: req.query.status as CatalogFilterParams['status'],
    sort: (req.query.sort as CatalogFilterParams['sort']) ?? 'recent',
  }

  const { pairs, mlLinkedIds, statusCounts } = await querySellerCatalog(req.scope, seller, filters)

  const count = pairs.length
  const page = pairs.slice(offset, offset + limit)

  res.json({
    seller,
    listings: page.map((p) => ({
      ...p.listing,
      channels: mlLinkedIds.has(p.listing.id) ? ['miyagi', 'ml'] : ['miyagi'],
      // Marketplace-browse visibility toggle (catalog-management S2 · 2.2) —
      // absent metadata key = today's behavior (always visible). Independent
      // of `status`/pause: this only affects `/l` browse, never the seller's
      // OWN storefront or this table itself.
      miyagi_visible: (p.raw.metadata as Record<string, unknown> | undefined)?.miyagi_visible !== false,
      // ML price override (catalog-management S2 · 2.3) — seller-private,
      // single-variant scope (matches unit_cost_cents' existing limitation).
      // "table shows both prices" acceptance criterion.
      ml_price_cents: (() => {
        const v = (p.raw.variants as any[] | undefined)?.[0]?.metadata?.ml_price_cents
        return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
      })(),
    })),
    products: page.map((p) => p.raw),
    count,
    status_counts: statusCounts,
    limit,
    offset,
  })
}

// POST /store/sellers/me/products — create a product for the authenticated seller
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) {
    return res.status(401).json({ message: 'Authentication required' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)

  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (!seller) {
    return res.status(404).json({ message: 'Seller profile not found. Create one first via POST /store/sellers/me' })
  }

  // Delegate to the shared create path (also used by the internal agent route).
  const result = await createSellerProduct(req.scope, seller.id, req.body as CreateProductBody)
  if (!result.ok) {
    return res.status(result.status).json({ message: result.message })
  }

  res.status(201).json({
    product_id: result.product_id,
    seller_slug: seller.slug,
  })
}
