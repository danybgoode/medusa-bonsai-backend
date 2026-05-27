import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'

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

  const { data: sellerProducts, metadata } = await remoteQuery.graph({
    entity: 'seller',
    fields: ['id', 'products.*', 'products.variants.*', 'products.images.*'],
    filters: { id: seller.id },
    pagination: { take: limit, skip: offset },
  })

  const products = (sellerProducts?.[0] as any)?.products ?? []

  res.json({
    seller: { id: seller.id, slug: seller.slug, name: seller.name },
    products,
    count: metadata?.count ?? products.length,
    limit,
    offset,
  })
}
