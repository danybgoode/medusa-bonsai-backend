import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'
import { isHiddenCatalogProduct } from '../../../_utils/support'
import { stripPrivateVariantMetadata } from '../../../_utils/listing'

// GET /store/sellers/:slug/products — all active products for a seller storefront
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const { slug } = req.params

  const [seller] = await sellerService.listSellers({ slug })
  if (!seller) {
    return res.status(404).json({ message: `Seller '${slug}' not found` })
  }

  // Use the remote query to join seller → products via the link table
  const remoteQuery = req.scope.resolve('remoteQuery')

  const limit = Math.min(parseInt(req.query.limit as string ?? '20'), 50)
  const offset = parseInt(req.query.offset as string ?? '0')

  const { data: sellerRows } = await remoteQuery.graph({
    entity: 'seller',
    fields: ['id', 'products.id'],
    filters: { id: seller.id },
  })

  const linkedIds = (((sellerRows?.[0] as { products?: Array<{ id: string }> } | undefined)?.products ?? [])
    .map((product) => product.id))
  const linkedIdSet = new Set(linkedIds)

  if (linkedIds.length === 0) {
    return res.json({
      seller,
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

  const matchedProducts = (allProducts ?? [])
    .filter((product: { id: string }) => linkedIdSet.has(product.id))
    .filter((product: { metadata?: unknown }) => !isHiddenCatalogProduct(product.metadata))
    .sort((a: { created_at?: string | Date }, b: { created_at?: string | Date }) =>
      new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()
    )
  // This route returns RAW product rows (incl. variant metadata — the
  // storefront filters on `disabled`), so seller-private keys must be
  // scrubbed here: without this, a public read leaks the seller's COGS
  // (`unit_cost_cents`) to anyone with the publishable key (profit-analyzer
  // S1 — pre-merge reviewer catch).
  const products = matchedProducts
    .slice(offset, offset + limit)
    .map(stripPrivateVariantMetadata)

  res.json({
    seller,
    products,
    count: matchedProducts.length,
    limit,
    offset,
  })
}
