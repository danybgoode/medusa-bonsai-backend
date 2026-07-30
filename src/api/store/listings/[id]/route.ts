import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { toListingShape } from '../../_utils/listing'
import { isHiddenCatalogProduct } from '../../_utils/support'
import { resolveSellerProductIds } from '../../_utils/seller-catalog-query'
import {
  MARKETPLACE_CHANNEL_FIELDS,
  productInMarketplaceChannel,
  resolveMarketReadGate,
} from '../../_utils/market-read'

// GET /store/listings/:id — single listing with seller enrichment
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params
  // Marketplace PDP reads sit behind the same market boundary as the list (D1) —
  // a product hidden from the `mx` grid must not be readable by guessing its id.
  const gate = resolveMarketReadGate((req.query as Record<string, string>)?.market, process.env)
  if (!gate.ok) {
    return res.status(gate.status).json(gate.body)
  }
  const remoteQuery = req.scope.resolve('remoteQuery')
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)

  const { data: products } = await remoteQuery.graph({
    entity: 'product',
    fields: [
      'id', 'title', 'description', 'status', 'metadata', 'created_at',
      ...MARKETPLACE_CHANNEL_FIELDS,
      'variants.*', 'variants.prices.*',
      'variants.inventory_items.inventory.location_levels.stocked_quantity',
      'variants.inventory_items.inventory.location_levels.reserved_quantity',
      'images.*',
      'categories.*',
      'type.*',
      'tags.*',
    ],
    filters: { id, status: 'published' },
  })

  const product = products?.[0]
  if (!product) {
    return res.status(404).json({ message: 'Listing not found' })
  }
  if ((product.metadata as any)?.is_print_placement || isHiddenCatalogProduct(product.metadata)) {
    return res.status(404).json({ message: 'Listing not found' })
  }
  // Not published into THIS market's marketplace channel ⇒ the marketplace does not
  // have this listing. Deliberately the same 404 body as "no such product": a
  // marketplace read is not entitled to learn that a product it may not see exists
  // somewhere else. The shop's own route still serves it (D4).
  if (!productInMarketplaceChannel(product, gate.channel_id)) {
    return res.status(404).json({ message: 'Listing not found' })
  }

  // Find which seller owns this product
  let seller: any = null
  const allSellers = await sellerService.listSellers({}, { take: 1000 })
  for (const s of allSellers) {
    try {
      const productIds = await resolveSellerProductIds(req.scope, s.id)
      if (productIds.has(id)) {
        seller = s
        break
      }
    } catch {
      // no products linked
    }
  }

  res.json({ listing: toListingShape(product, seller, gate.market), market_code: gate.market })
}
