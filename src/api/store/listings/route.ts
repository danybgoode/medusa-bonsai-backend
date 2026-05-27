import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'
import { toListingShape } from '../_utils/listing'

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
        const { data: sellerRows } = await remoteQuery.graph({
          entity: 'seller',
          fields: ['id', 'products.id'],
          filters: { id: seller.id },
        })
        for (const row of (sellerRows ?? []) as any[]) {
          for (const prod of row.products ?? []) {
            productToSeller.set(prod.id, seller)
          }
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
  if (q.q) {
    const needle = q.q.toLowerCase()
    listings = listings.filter((l: any) =>
      l.title.toLowerCase().includes(needle) ||
      (l.description ?? '').toLowerCase().includes(needle)
    )
  }
  if (q.category) listings = listings.filter((l: any) => l.category === q.category)
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

  // Autos filters
  if (q.brand) listings = listings.filter((l: any) => (l.metadata?.brand as string ?? '').toLowerCase().includes(q.brand.toLowerCase()))
  if (q.year_from) listings = listings.filter((l: any) => parseInt(l.metadata?.year as string ?? '0') >= parseInt(q.year_from))
  if (q.year_to) listings = listings.filter((l: any) => parseInt(l.metadata?.year as string ?? '9999') <= parseInt(q.year_to))
  if (q.km_from) listings = listings.filter((l: any) => parseInt(l.metadata?.km as string ?? '0') >= parseInt(q.km_from))
  if (q.km_to) listings = listings.filter((l: any) => parseInt(l.metadata?.km as string ?? '9999999') <= parseInt(q.km_to))
  if (q.transmission) listings = listings.filter((l: any) => l.metadata?.transmission === q.transmission)
  if (q.fuel) listings = listings.filter((l: any) => l.metadata?.fuel === q.fuel)

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
  else listings.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  // ── Step 6: Paginate ──────────────────────────────────────────────────────
  const total = listings.length
  const offset = (pageNum - 1) * limitParam
  const page = listings.slice(offset, offset + limitParam)

  res.json({ listings: page, total, page: pageNum, limit: limitParam, offset })
}
