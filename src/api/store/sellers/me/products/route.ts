import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { IProductModuleService } from '@medusajs/framework/types'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'
import { extractClerkUserId } from '../../../_utils/clerk-auth'
import { toListingShape } from '../../../_utils/listing'

interface CreateProductBody {
  title: string
  description?: string | null
  price_cents?: number | null
  currency?: string
  condition?: string | null
  listing_type?: string
  category?: string       // category handle
  state?: string | null
  municipio?: string | null
  location?: string | null
  images?: Array<{ url: string; alt?: string }>
  tags?: string[]
  metadata?: Record<string, unknown>
}

// GET /store/sellers/me/products — list all products for the authenticated seller
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

  const { data: rows, metadata } = await remoteQuery.graph({
    entity: 'seller',
    fields: [
      'id',
      'products.id',
      'products.title',
      'products.description',
      'products.status',
      'products.metadata',
      'products.created_at',
      'products.variants.*',
      'products.variants.prices.*',
      'products.images.*',
      'products.categories.*',
      'products.type.*',
      'products.tags.*',
    ],
    filters: { id: seller.id },
    pagination: { take: limit, skip: offset },
  })

  const products = ((rows?.[0] as { products?: unknown[] } | undefined)?.products ?? [])
  const listings = products
    .map((product) => toListingShape(product, seller))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  res.json({
    seller,
    listings,
    products,
    count: metadata?.count ?? listings.length,
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
  const productService: IProductModuleService = req.scope.resolve(Modules.PRODUCT)
  const remoteLink = req.scope.resolve(ContainerRegistrationKeys.LINK)

  // Get or auto-create seller
  let [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (!seller) {
    return res.status(404).json({ message: 'Seller profile not found. Create one first via POST /store/sellers/me' })
  }

  const body = req.body as CreateProductBody

  if (!body.title?.trim() || body.title.trim().length < 3) {
    return res.status(400).json({ message: 'title must be at least 3 characters' })
  }

  // ── Look up category by handle ──────────────────────────────────────────
  let categoryId: string | undefined
  if (body.category) {
    const [cat] = await productService.listProductCategories({ handle: body.category })
    categoryId = cat?.id
  }

  // ── Look up product type by value ────────────────────────────────────────
  const typeValue = body.listing_type ?? 'physical'
  const [ptype] = await productService.listProductTypes({ value: typeValue })

  // ── Build metadata ───────────────────────────────────────────────────────
  const locationDisplay = [body.municipio?.trim(), body.state?.trim()].filter(Boolean).join(', ') || body.location || null

  const metadata: Record<string, unknown> = {
    ...(body.condition ? { condition: body.condition } : {}),
    ...(body.state ? { state: body.state } : {}),
    ...(body.municipio ? { municipio: body.municipio } : {}),
    ...(body.location ? { location: body.location } : {}),
    views: 0,
    ...(body.metadata ?? {}),
  }

  // ── Create Medusa product ────────────────────────────────────────────────
  const product = await (productService as any).createProducts({
    title: body.title.trim().slice(0, 100),
    description: body.description?.trim() || null,
    status: 'published' as const,
    ...(categoryId ? { categories: [{ id: categoryId }] } : {}),
    ...(ptype ? { type_id: ptype.id } : {}),
    images: (body.images ?? []).map((img) => ({
      url: img.url,
      metadata: img.alt ? { alt: img.alt } : undefined,
    })),
    tags: (body.tags ?? []).map((v) => ({ value: v })),
    metadata,
    variants: [
      {
        title: 'Default',
        manage_inventory: false,
        prices: body.price_cents != null && body.price_cents > 0
          ? [{ amount: body.price_cents, currency_code: (body.currency ?? 'MXN').toLowerCase() }]
          : [],
      },
    ],
  })

  // ── Link product to seller ───────────────────────────────────────────────
  await remoteLink.create({
    [SELLER_MODULE]: { seller_id: seller.id },
    [Modules.PRODUCT]: { product_id: product.id },
  })

  res.status(201).json({
    product_id: product.id,
    seller_slug: seller.slug,
  })
}
