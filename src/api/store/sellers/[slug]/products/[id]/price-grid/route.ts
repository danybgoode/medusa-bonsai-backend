import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../../../modules/seller'
import SellerModuleService from '../../../../../../../modules/seller/service'
import { MARKETS } from '../../../../../../../lib/markets'
import { requireSellerOperatingMarket } from '../../../../../../../lib/seller-market'
import { buildPriceGrid } from '../../../../../_utils/price-grid'
import { isHiddenCatalogProduct } from '../../../../../_utils/support'
import { resolveSellerProductIds } from '../../../../../_utils/seller-catalog-query'

/**
 * Owned-shop price ladder. It mirrors the owned PDP's authorization and derives its
 * currency from the seller's registry market, never the MX marketplace channel.
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
      'id', 'status', 'metadata',
      'variants.id', 'variants.manage_inventory', 'variants.metadata',
      'variants.options.value', 'variants.options.option.title',
      'variants.prices.amount', 'variants.prices.currency_code',
      'variants.prices.min_quantity', 'variants.prices.max_quantity',
    ],
    filters: { id, status: 'published' },
  })
  const product = products?.[0] as any
  if (!product || product.metadata?.is_print_placement || isHiddenCatalogProduct(product.metadata)) {
    return res.status(404).json({ message: 'Listing not found' })
  }

  return res.json({
    price_grid: buildPriceGrid(product, MARKETS[market].currency_code),
    market_code: market,
  })
}
