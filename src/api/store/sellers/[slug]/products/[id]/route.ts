import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../../modules/seller'
import SellerModuleService from '../../../../../../modules/seller/service'
import { requireSellerOperatingMarket } from '../../../../../../lib/seller-market'
import { isHiddenCatalogProduct } from '../../../../_utils/support'
import { resolveSellerProductIds } from '../../../../_utils/seller-catalog-query'
import { toListingShape, toSellerShape } from '../../../../_utils/listing'

/**
 * Owned-shop PDP. Ownership + publish state are the visibility boundary; marketplace
 * Sales Channel membership is intentionally irrelevant (D4).
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { slug, id } = req.params
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug })
  if (!seller) return res.status(404).json({ message: 'Listing not found' })

  let market
  try {
    market = requireSellerOperatingMarket(seller)
  } catch (e) {
    return res.status(422).json({ message: (e as Error).message })
  }

  const owned = await resolveSellerProductIds(req.scope, seller.id)
  if (!owned.has(id)) return res.status(404).json({ message: 'Listing not found' })

  const remoteQuery = req.scope.resolve('remoteQuery')
  const { data: products } = await remoteQuery.graph({
    entity: 'product',
    fields: [
      'id', 'title', 'description', 'status', 'metadata', 'created_at',
      'variants.*', 'variants.prices.*',
      'variants.inventory_items.inventory.location_levels.stocked_quantity',
      'variants.inventory_items.inventory.location_levels.reserved_quantity',
      'images.*', 'categories.*', 'type.*', 'tags.*',
    ],
    filters: { id, status: 'published' },
  })
  const product = products?.[0] as any
  if (!product || product.metadata?.is_print_placement || isHiddenCatalogProduct(product.metadata)) {
    return res.status(404).json({ message: 'Listing not found' })
  }

  return res.json({
    listing: toListingShape(product, seller, market),
    seller: toSellerShape(seller),
    market_code: market,
  })
}
