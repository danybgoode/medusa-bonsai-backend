import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { IProductModuleService } from '@medusajs/framework/types'
import { createProductsWorkflow } from '@medusajs/medusa/core-flows'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'
import { extractClerkUserId } from '../../../_utils/clerk-auth'
import { toListingShape } from '../../../_utils/listing'
import {
  isStockableListingType,
  resolveStockLocationId,
  provisionVariantInventory,
} from '../../../_utils/inventory'

/** Auto-generate a unique SKU for P2P marketplace items. */
function generateSku(): string {
  const ts = Date.now().toString(36).toUpperCase()
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase()
  return `MIYAGI-${ts}-${rand}`
}

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
  quantity?: number | null
  weight_grams?: number | null
  images?: Array<{ url: string; alt?: string }>
  tags?: string[]
  attrs?: Record<string, unknown>  // type/category-specific attributes (brand, size, color…)
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
      'id', 'title', 'description', 'status', 'metadata', 'weight', 'created_at',
      'variants.*', 'variants.sku', 'variants.prices.*',
      'variants.inventory_items.inventory.location_levels.stocked_quantity',
      'variants.inventory_items.inventory.location_levels.reserved_quantity',
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
    // Category/type-specific structured attributes (brand, size, color, year, km…)
    ...(body.attrs && Object.keys(body.attrs).length > 0 ? { attrs: body.attrs } : {}),
    ...(body.metadata ?? {}),
  }

  // ── Resolve the sales channel ────────────────────────────────────────────
  // The product MUST be in the store's sales channel, otherwise the standard
  // (channel-scoped) /store/products endpoint 404s and checkout fails with
  // "Product not found" even though the custom /store/listings endpoint shows it.
  let salesChannelId: string | undefined = process.env.MEDUSA_SALES_CHANNEL_ID || undefined
  if (!salesChannelId) {
    try {
      const storeService: any = req.scope.resolve(Modules.STORE)
      const [store] = await storeService.listStores({}, { select: ['default_sales_channel_id'], take: 1 })
      salesChannelId = store?.default_sales_channel_id ?? undefined
    } catch (e) {
      console.error('[sellers/me/products] sales channel resolve failed:', e)
    }
  }

  // ── Inventory: physical `product` listings are unique-stock items ─────────
  // Managed variants let Medusa's completeCartWorkflow reserve stock on order
  // placement and block double-selling. service/rental/digital/subscription are
  // not stockable. Default quantity 1 (unique P2P item).
  const manageInventory = isStockableListingType(body.listing_type)
  const quantity = Math.max(0, Math.floor(body.quantity ?? 1))
  const sku = generateSku()
  const weightGrams = body.weight_grams != null && body.weight_grams > 0
    ? Math.round(body.weight_grams)
    : undefined

  // ── Create Medusa product ────────────────────────────────────────────────
  const { result } = await createProductsWorkflow(req.scope).run({
    input: {
      products: [{
        title: body.title.trim().slice(0, 100),
        description: body.description?.trim() || null,
        status: 'published' as const,
        ...(weightGrams !== undefined ? { weight: weightGrams } : {}),
        ...(salesChannelId ? { sales_channels: [{ id: salesChannelId }] } : {}),
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
          // Use the product title as the variant title so Admin shows meaningful names
          // instead of "Default". P2P items are unique, so there's always one variant.
          title: body.title.trim().slice(0, 100),
          sku,
          options: {
            Default: 'Default',
          },
          manage_inventory: manageInventory,
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

  // ── Provision inventory level for managed (physical) products ─────────────
  // The managed variant's inventory item is auto-created by the product workflow;
  // here we create the stock level at the seeded location and ensure that location
  // is linked to the sales channel so reservations succeed on order placement.
  if (manageInventory) {
    const variantId = (product.variants?.[0] as { id?: string } | undefined)?.id
    const locationId = await resolveStockLocationId(req.scope)
    if (variantId && locationId) {
      await provisionVariantInventory(req.scope, {
        variantId,
        salesChannelId,
        locationId,
        quantity,
      })
    } else {
      console.error('[sellers/me/products] inventory not provisioned:', { variantId, locationId })
    }
  }

  res.status(201).json({
    product_id: product.id,
    seller_slug: seller.slug,
  })
}
