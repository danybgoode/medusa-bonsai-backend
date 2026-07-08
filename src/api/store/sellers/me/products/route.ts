import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'
import { MERCADOLIBRE_MODULE } from '../../../../../modules/mercadolibre'
import MercadolibreModuleService from '../../../../../modules/mercadolibre/service'
import { extractClerkUserId } from '../../../_utils/clerk-auth'
import { toListingShape, type ListingShape } from '../../../_utils/listing'
import { createSellerProduct, type CreateProductBody } from '../../../_utils/seller-product-create'
import { isHiddenCatalogProduct } from '../../../_utils/support'

// GET /store/sellers/me/products — list all products for the authenticated seller
//
// Optional server-side filters for the catalog-management table (Sprint 1 ·
// Story 1.2), all additive — a request with none of these behaves exactly as
// before: `q` (title search), `status` (activo|agotado|borrador|pausado —
// the fine split catalog-status.ts on the frontend also derives), `category`
// (category handle), `channel` (miyagi|ml), `stock` (in_stock|agotado|unlimited),
// `sort` (recent|title|price_asc|price_desc).
//
// `id`, and `status`'s coarse published/draft split, `title` search, and
// `categories.handle` are pushed down to the DB filter on the seller's linked
// products — real filtering, not "fetch everything then slice." Stock-state,
// the ML channel badge, and the hidden-catalog exclusion are computed /
// cross-module fields that can't be expressed as a remoteQuery filter; those
// run in-memory on this already seller-scoped, DB-narrowed batch (never the
// full store catalog) before the final offset/limit slice + count, so a page
// is never short a row. Pushing `id: linkedIds` down also fixes a latent bug
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

  const remoteQuery = req.scope.resolve('remoteQuery')
  const limit = Math.min(parseInt(req.query.limit as string ?? '100'), 200)
  const offset = parseInt(req.query.offset as string ?? '0')
  const q = (req.query.q as string | undefined)?.trim() || undefined
  const category = (req.query.category as string | undefined)?.trim() || undefined
  const channel = req.query.channel as string | undefined // 'miyagi' | 'ml'
  const stock = req.query.stock as string | undefined // 'in_stock' | 'agotado' | 'unlimited'
  const sort = (req.query.sort as string | undefined) ?? 'recent'
  const statusParam = req.query.status as string | undefined // 'activo'|'agotado'|'borrador'|'pausado'
  // Coarse native-status pushdown; the fine activo/agotado/borrador/pausado
  // split (stock + metadata.paused) happens in-memory below.
  const nativeStatus = statusParam === 'activo' || statusParam === 'agotado'
    ? 'published'
    : statusParam === 'borrador' || statusParam === 'pausado'
      ? 'draft'
      : undefined

  const { data: rows } = await remoteQuery.graph({
    entity: 'seller',
    fields: ['id', 'products.id'],
    filters: { id: seller.id },
  })

  const linkedIds = (((rows?.[0] as { products?: Array<{ id: string }> } | undefined)?.products ?? [])
    .map((product) => product.id))

  if (linkedIds.length === 0) {
    return res.json({ seller, listings: [], products: [], count: 0, limit, offset })
  }

  const dbFilters: Record<string, unknown> = { id: linkedIds }
  if (nativeStatus) dbFilters.status = nativeStatus
  if (q) dbFilters.title = { $ilike: `%${q}%` }
  if (category) dbFilters.categories = { handle: category }

  const { data: matchedProductsRaw } = await remoteQuery.graph({
    entity: 'product',
    fields: [
      'id', 'title', 'description', 'status', 'metadata', 'weight', 'created_at',
      'variants.*', 'variants.sku', 'variants.prices.*',
      'variants.inventory_items.inventory.location_levels.stocked_quantity',
      'variants.inventory_items.inventory.location_levels.reserved_quantity',
      'images.*',
      'categories.*',
      'type.*',
      'tags.*',
    ],
    filters: dbFilters,
    // Bounded at this seller's own linked-product count (never the global
    // catalog) — same ceiling the old unconditional fetch used, so no
    // regression for a seller with no active filter.
    pagination: { take: Math.min(linkedIds.length, 2000), skip: 0 },
  })

  // Raw product + its toListingShape pair, filtered/sorted/sliced together so
  // `products` (raw — consumed by launchpad's option pickers) never drifts out
  // of sync with `listings` (normalized — consumed by the manage dashboard/table).
  let pairs = (matchedProductsRaw ?? [])
    .filter((product: { metadata?: unknown }) => !isHiddenCatalogProduct(product.metadata))
    .map((product) => ({ raw: product, listing: toListingShape(product, seller) }))

  if (channel === 'ml' || channel === 'miyagi') {
    const mlService: MercadolibreModuleService = req.scope.resolve(MERCADOLIBRE_MODULE)
    const links = await mlService.listProductMlLinks({ product_id: pairs.map((p) => p.listing.id) })
    const mlLinkedIds = new Set(links.map((link: { product_id: string }) => link.product_id))
    pairs = pairs.filter((p) => (channel === 'ml' ? mlLinkedIds.has(p.listing.id) : !mlLinkedIds.has(p.listing.id)))
  }

  if (stock === 'in_stock') pairs = pairs.filter((p) => p.listing.in_stock)
  else if (stock === 'agotado') pairs = pairs.filter((p) => p.listing.manage_inventory && !p.listing.in_stock)
  else if (stock === 'unlimited') pairs = pairs.filter((p) => !p.listing.manage_inventory)

  if (statusParam === 'activo') pairs = pairs.filter((p) => p.listing.status === 'active' && p.listing.in_stock)
  else if (statusParam === 'agotado') pairs = pairs.filter((p) => p.listing.status === 'active' && !p.listing.in_stock)
  else if (statusParam === 'borrador') pairs = pairs.filter((p) => p.listing.status === 'draft')
  else if (statusParam === 'pausado') pairs = pairs.filter((p) => p.listing.status === 'paused')

  pairs.sort((a, b) => {
    if (sort === 'title') return a.listing.title.localeCompare(b.listing.title)
    if (sort === 'price_asc') return (a.listing.price_cents ?? Infinity) - (b.listing.price_cents ?? Infinity)
    if (sort === 'price_desc') return (b.listing.price_cents ?? -Infinity) - (a.listing.price_cents ?? -Infinity)
    return new Date(b.listing.created_at).getTime() - new Date(a.listing.created_at).getTime() // 'recent' default
  })

  const count = pairs.length
  const page = pairs.slice(offset, offset + limit)

  res.json({
    seller,
    listings: page.map((p) => p.listing),
    products: page.map((p) => p.raw),
    count,
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
