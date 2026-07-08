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

  const remoteQuery = req.scope.resolve('remoteQuery')
  const limit = Math.min(parseInt(req.query.limit as string ?? '100'), 200)
  const offset = parseInt(req.query.offset as string ?? '0')
  const q = (req.query.q as string | undefined)?.trim() || undefined
  const category = (req.query.category as string | undefined)?.trim() || undefined
  const channel = req.query.channel as string | undefined // 'miyagi' | 'ml'
  const stock = req.query.stock as string | undefined // 'in_stock' | 'agotado' | 'unlimited'
  const sort = (req.query.sort as string | undefined) ?? 'recent'
  const statusParam = req.query.status as string | undefined // 'activo'|'agotado'|'borrador'|'pausado'|'sobre_pedido'

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

  // Always resolved (not just when `channel` filters) — every row's channel
  // badge needs it. S2.2 adds real per-channel toggles; the badge itself is
  // fixed here to respect `ml_status` — a CLOSED link no longer shows the ML
  // badge (Sprint 1's read-only badge checked existence only, a known/
  // accepted gap noted in that sprint's README — fixed as a byproduct of this
  // story's channel-badge work, not new gated behavior).
  const mlService: MercadolibreModuleService = req.scope.resolve(MERCADOLIBRE_MODULE)
  const mlLinks = await mlService.listProductMlLinks({ product_id: pairs.map((p) => p.listing.id) })
  const mlLinkedIds = new Set(
    mlLinks
      .filter((link: { metadata?: Record<string, unknown> | null }) => link.metadata?.ml_status !== 'closed')
      .map((link: { product_id: string }) => link.product_id),
  )

  if (channel === 'ml' || channel === 'miyagi') {
    pairs = pairs.filter((p) => (channel === 'ml' ? mlLinkedIds.has(p.listing.id) : !mlLinkedIds.has(p.listing.id)))
  }

  if (stock === 'in_stock') pairs = pairs.filter((p) => p.listing.in_stock)
  else if (stock === 'agotado') pairs = pairs.filter((p) => p.listing.manage_inventory && !p.listing.in_stock)
  else if (stock === 'unlimited') pairs = pairs.filter((p) => !p.listing.manage_inventory)

  // Counts per state — computed BEFORE the status filter narrows `pairs`, so a
  // seller sees "3 activos, 1 pausado" for whatever channel/stock/search filters
  // are active, not just the currently-selected status. Mirrors the fine-split
  // rule in the frontend's lib/catalog-status.ts (`deriveCatalogStatus`) — kept
  // in lockstep by hand since the two repos don't share a module.
  // Hand-mirrors the frontend's deriveCatalogStatus() (lib/catalog-status.ts)
  // — the two must stay in lockstep by hand, no shared package between repos
  // (documented fragility, Sprint 1). Sprint 2 · Story 2.1 adds a 5th bucket:
  // a backorder ("sobre pedido") listing is ALWAYS `sobre_pedido`, regardless
  // of in_stock, checked before the agotado branch — the whole point of the
  // story is that qty 0 stops meaning "vanished" for a backorder item.
  const isSobrePedido = (l: { manage_inventory: boolean; allow_backorder: boolean }) =>
    l.manage_inventory && l.allow_backorder
  const statusCounts = { activo: 0, agotado: 0, borrador: 0, pausado: 0, sobre_pedido: 0 }
  for (const p of pairs) {
    if (p.listing.status === 'paused') statusCounts.pausado++
    else if (p.listing.status === 'active') {
      if (isSobrePedido(p.listing)) statusCounts.sobre_pedido++
      else statusCounts[p.listing.in_stock ? 'activo' : 'agotado']++
    } else statusCounts.borrador++
  }

  if (statusParam === 'activo') {
    pairs = pairs.filter((p) => p.listing.status === 'active' && p.listing.in_stock && !isSobrePedido(p.listing))
  } else if (statusParam === 'agotado') {
    pairs = pairs.filter((p) => p.listing.status === 'active' && !p.listing.in_stock && !isSobrePedido(p.listing))
  } else if (statusParam === 'sobre_pedido') {
    pairs = pairs.filter((p) => p.listing.status === 'active' && isSobrePedido(p.listing))
  } else if (statusParam === 'borrador') pairs = pairs.filter((p) => p.listing.status === 'draft')
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
    listings: page.map((p) => ({
      ...p.listing,
      channels: mlLinkedIds.has(p.listing.id) ? ['miyagi', 'ml'] : ['miyagi'],
      // Marketplace-browse visibility toggle (catalog-management S2 · 2.2) —
      // absent metadata key = today's behavior (always visible). Independent
      // of `status`/pause: this only affects `/l` browse, never the seller's
      // OWN storefront or this table itself.
      miyagi_visible: (p.raw.metadata as Record<string, unknown> | undefined)?.miyagi_visible !== false,
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
