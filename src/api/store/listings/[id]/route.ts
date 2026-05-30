import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { toListingShape } from '../../_utils/listing'

// GET /store/listings/:id — single listing with seller enrichment
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params
  const remoteQuery = req.scope.resolve('remoteQuery')
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)

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
    filters: { id, status: 'published' },
  })

  const product = products?.[0]
  if (!product) {
    return res.status(404).json({ message: 'Listing not found' })
  }

  // Find which seller owns this product
  let seller: any = null
  const allSellers = await sellerService.listSellers({}, { take: 1000 })
  for (const s of allSellers) {
    try {
      const { data: rows } = await remoteQuery.graph({
        entity: 'seller',
        fields: ['id', 'products.id'],
        filters: { id: s.id },
      })
      const productIds = ((rows?.[0] as any)?.products ?? []).map((p: any) => p.id)
      if (productIds.includes(id)) {
        seller = s
        break
      }
    } catch {
      // no products linked
    }
  }

  res.json({ listing: toListingShape(product, seller) })
}
