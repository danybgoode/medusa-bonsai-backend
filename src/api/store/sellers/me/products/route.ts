import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'
import { extractClerkUserId } from '../../../_utils/clerk-auth'
import { toListingShape } from '../../../_utils/listing'
import { createSellerProduct, type CreateProductBody } from '../../../_utils/seller-product-create'
import { isHiddenCatalogProduct } from '../../../_utils/support'

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

  const matchedProducts = (allProducts ?? [])
    .filter((product: { id: string }) => linkedIdSet.has(product.id))
    .filter((product: { metadata?: unknown }) => !isHiddenCatalogProduct(product.metadata))
    .sort((a: { created_at?: string | Date }, b: { created_at?: string | Date }) =>
      new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()
    )
  const products = matchedProducts
    .slice(offset, offset + limit)
  const listings = products
    .map((product) => toListingShape(product, seller))

  res.json({
    seller,
    listings,
    products,
    count: matchedProducts.length,
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
