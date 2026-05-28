import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { IProductModuleService } from '@medusajs/framework/types'
import { createProductsWorkflow } from '@medusajs/medusa/core-flows'
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

  const { data: rows } = await remoteQuery.graph({
    entity: 'seller',
    fields: ['id', 'products.id'],
    filters: { id: seller.id },
  })

  const linkedIds = (((rows?.[0] as { products?: Array<{ id: string }> } | undefined)?.products ?? [])
    .map((product) => product.id))
  const linkedIdSet = new Set(linkedIds)

  if (linkedIds.length === 0) {
    return res.json({
      seller,
      listings: [],
      products: [],
      count: 0,
      limit,
      offset,
    })
  }

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
    pagination: { take: 2000, skip: 0 },
  })

  const products = (allProducts ?? [])
    .filter((product: { id: string }) => linkedIdSet.has(product.id))
    .sort((a: { created_at?: string | Date }, b: { created_at?: string | Date }) =>
      new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()
    )
    .slice(offset, offset + limit)
  const listings = products
    .map((product) => toListingShape(product, seller))

  res.json({
    seller,
    listings,
    products,
    count: linkedIds.length,
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
    ...(body.price_cents != null ? { price_cents: body.price_cents } : {}),
    currency: body.currency ?? 'MXN',
    listing_type: body.listing_type ?? 'product',
    views: 0,
    ...(body.metadata ?? {}),
  }

  // ── Create Medusa product ────────────────────────────────────────────────
  const { result } = await createProductsWorkflow(req.scope).run({
    input: {
      products: [{
        title: body.title.trim().slice(0, 100),
        description: body.description?.trim() || null,
        status: 'published' as const,
        ...(categoryId ? { category_ids: [categoryId] } : {}),
        ...(ptype ? { type_id: ptype.id } : {}),
        images: (body.images ?? []).map((img) => ({
          url: img.url,
          metadata: img.alt ? { alt: img.alt } : undefined,
        })),
        options: [{
          title: 'Default',
          values: ['Default'],
        }],
        metadata,
        variants: [{
          title: 'Default',
          options: {
            Default: 'Default',
          },
          manage_inventory: false,
          prices: body.price_cents != null && body.price_cents > 0
            ? [{ amount: body.price_cents, currency_code: (body.currency ?? 'MXN').toLowerCase() }]
            : [],
        }],
      }],
    },
  })
  const product = result[0]

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
