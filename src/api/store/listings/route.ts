import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'
import { toListingShape, isFeaturedPin } from '../_utils/listing'
import { isHiddenCatalogProduct } from '../_utils/support'
import { resolveSellerProductIds } from '../_utils/seller-catalog-query'
import { isEnabled } from '../../../lib/flags'
import {
  carMake, carYear, carTransmission, carFuel,
  matchesBrand, matchesModel, matchesYearFrom, matchesYearTo, matchesKmFrom, matchesKmTo,
  toCarFacetPoolEntry,
} from '../_utils/car-listing'

const PAGE_SIZE = 24

// GET /store/listings — full product catalog with seller enrichment + metadata filters
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const q = req.query as Record<string, string>
  const pageNum = Math.max(1, parseInt(q.page ?? '1'))
  const limitParam = Math.min(parseInt(q.limit ?? String(PAGE_SIZE)), 100)

  const remoteQuery = req.scope.resolve('remoteQuery')
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)

  // ── Step 1: Fetch all published products with full field expansion ──────────
  const { data: products } = await remoteQuery.graph({
    entity: 'product',
    fields: [
      'id', 'title', 'description', 'status', 'metadata', 'created_at',
      'variants.*', 'variants.prices.*',
      'variants.inventory_items.inventory.location_levels.stocked_quantity',
      'variants.inventory_items.inventory.location_levels.reserved_quantity',
      'images.*',
      'categories.*',
      'type.*',
      'tags.*',
    ],
    filters: { status: 'published' },
    pagination: { take: 2000, skip: 0 },
  })

  // ── Step 2: Build product_id → seller map ──────────────────────────────────
  // Fetch all sellers (plain list, no link traversal)
  const allSellers = await sellerService.listSellers({}, { take: 1000 })
  const productToSeller = new Map<string, any>()

  // For each seller, query their linked products using the working graph pattern
  await Promise.all(
    allSellers.map(async (seller) => {
      try {
        const productIds = await resolveSellerProductIds(req.scope, seller.id)
        for (const productId of productIds) {
          productToSeller.set(productId, seller)
        }
      } catch {
        // Seller has no linked products yet — skip
      }
    })
  )

  // ── Step 3: Map to listing shape ──────────────────────────────────────────
  let listings = (products ?? []).map((p: any) =>
    toListingShape(p, productToSeller.get(p.id))
  )

  // ── Step 4: Apply filters ─────────────────────────────────────────────────
  // Print-ad placements and support primitives are sold through dedicated flows only.
  listings = listings.filter((l: any) => !(l.metadata?.is_print_placement) && !isHiddenCatalogProduct(l.metadata))
  // Marketplace-browse visibility toggle (catalog-management S2 · 2.2) — a
  // NEW, narrowly-scoped filter, deliberately NOT folded into
  // `isHiddenCatalogProduct` (that deriver's contract is "hidden everywhere,"
  // reused by the PDP route and the seller's own storefront route too; this
  // toggle must affect ONLY marketplace browse — a shop's own storefront
  // always shows its own active products regardless). Gated: while the flag
  // is OFF, `miyagi_visible` is never checked (today's behavior — nothing is
  // ever filtered on it, since the write path can't set it false either).
  if (await isEnabled('catalog.inventory_channels_enabled')) {
    listings = listings.filter((l: any) => l.metadata?.miyagi_visible !== false)
  }
  if (q.q) {
    const needle = q.q.toLowerCase()
    listings = listings.filter((l: any) =>
      l.title.toLowerCase().includes(needle) ||
      (l.description ?? '').toLowerCase().includes(needle)
    )
  }
  if (q.category) listings = listings.filter((l: any) => l.category === q.category)

  // ── Facet pool (cars-vertical S1.1) ────────────────────────────────────────
  // `?category=autos&facets=1` returns a compact per-car projection over the FULL
  // visibility-filtered autos set (before the facet filters + pagination below),
  // so the frontend's pure deriveCarFacets() can build the rail with honest
  // full-catalog availability counts, uncapped by the 24/page limit. Short-circuit
  // — the caller wants only the pool, not the heavy listing bodies.
  if (q.facets === '1' && q.category === 'autos') {
    const facet_pool = listings.map(toCarFacetPoolEntry)
    res.json({ facet_pool, total: facet_pool.length })
    return
  }

  if (q.condition) listings = listings.filter((l: any) => l.condition === q.condition)
  if (q.state) listings = listings.filter((l: any) => l.state === q.state)
  if (q.municipio) {
    const m = q.municipio.toLowerCase()
    listings = listings.filter((l: any) => l.municipio?.toLowerCase().includes(m))
  }
  if (q.location) {
    const loc = q.location.toLowerCase()
    listings = listings.filter((l: any) => l.location?.toLowerCase().includes(loc))
  }
  if (q.min_price) listings = listings.filter((l: any) => l.price_cents != null && l.price_cents >= parseInt(q.min_price) * 100)
  if (q.max_price) listings = listings.filter((l: any) => l.price_cents != null && l.price_cents <= parseInt(q.max_price) * 100)

  // Seller + listing type filters
  if (q.seller_slug) {
    const target = allSellers.find((s: any) => s.slug === q.seller_slug)
    listings = target ? listings.filter((l: any) => l.shop_id === target.id) : []
  }
  if (q.listing_type) listings = listings.filter((l: any) => l.listing_type === q.listing_type)
  // Selección: fetch only admin/seller pins so the homepage can render a pin regardless of
  // freshness (seleccion-pins-authoritative S2.1). Additive — absent param = unchanged.
  if (q.featured === 'true') listings = listings.filter(isFeaturedPin)

  // Autos filters — reconciled across both metadata namespaces (cars-vertical
  // S1.1): the accessors read the authoritative `attrs.*` (real seller cars)
  // first, falling back to the legacy top-level keys (seeded cars). `model` is
  // new (attrs-only; no legacy equivalent). transmission/fuel use the same
  // attrs-first accessors so a seller-captured car's automatico/gasolina match.
  if (q.brand) listings = listings.filter((l: any) => matchesBrand(l, q.brand))
  if (q.model) listings = listings.filter((l: any) => matchesModel(l, q.model))
  if (q.year_from) listings = listings.filter((l: any) => matchesYearFrom(l, parseInt(q.year_from)))
  if (q.year_to) listings = listings.filter((l: any) => matchesYearTo(l, parseInt(q.year_to)))
  if (q.km_from) listings = listings.filter((l: any) => matchesKmFrom(l, parseInt(q.km_from)))
  if (q.km_to) listings = listings.filter((l: any) => matchesKmTo(l, parseInt(q.km_to)))
  if (q.transmission) listings = listings.filter((l: any) => carTransmission(l) === q.transmission)
  if (q.fuel) listings = listings.filter((l: any) => carFuel(l) === q.fuel)

  // Inmuebles filters
  if (q.rooms_min) listings = listings.filter((l: any) => parseInt(l.metadata?.rooms as string ?? '0') >= parseInt(q.rooms_min))
  if (q.rooms_max) listings = listings.filter((l: any) => parseInt(l.metadata?.rooms as string ?? '999') <= parseInt(q.rooms_max))
  if (q.surface_min) listings = listings.filter((l: any) => parseInt(l.metadata?.surface as string ?? '0') >= parseInt(q.surface_min))
  if (q.surface_max) listings = listings.filter((l: any) => parseInt(l.metadata?.surface as string ?? '999999') <= parseInt(q.surface_max))
  if (q.property_type) {
    const types = q.property_type.split(',').filter(Boolean)
    if (types.length > 0) listings = listings.filter((l: any) => types.includes(l.metadata?.property_type as string))
  }

  // ── Step 5: Sort ──────────────────────────────────────────────────────────
  const sort = q.sort ?? 'reciente'
  if (sort === 'precio_asc') listings.sort((a: any, b: any) => (a.price_cents ?? 0) - (b.price_cents ?? 0))
  else if (sort === 'precio_desc') listings.sort((a: any, b: any) => (b.price_cents ?? 0) - (a.price_cents ?? 0))
  else if (sort === 'popular') listings.sort((a: any, b: any) => (b.views ?? 0) - (a.views ?? 0))
  // Autos-parity sorts (cars-vertical S1.2) — año newest/oldest and marca A–Z.
  // Cars with an unknown year/marca sort to the end so they never lead the grid.
  else if (sort === 'year_desc') listings.sort((a: any, b: any) => (carYear(b) ?? -Infinity) - (carYear(a) ?? -Infinity))
  else if (sort === 'year_asc') listings.sort((a: any, b: any) => (carYear(a) ?? Infinity) - (carYear(b) ?? Infinity))
  else if (sort === 'marca') listings.sort((a: any, b: any) => {
    const ma = carMake(a).toLowerCase(), mb = carMake(b).toLowerCase()
    if (!ma !== !mb) return ma ? -1 : 1   // empties last
    return ma.localeCompare(mb, 'es')
  })
  else listings.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  // ── Step 6: Paginate ──────────────────────────────────────────────────────
  const total = listings.length
  const offset = (pageNum - 1) * limitParam
  const page = listings.slice(offset, offset + limitParam)

  res.json({ listings: page, total, page: pageNum, limit: limitParam, offset })
}
