import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { IProductModuleService } from '@medusajs/framework/types'
import { SELLER_MODULE } from '../../../../../../modules/seller'
import SellerModuleService from '../../../../../../modules/seller/service'
import { extractClerkUserId } from '../../../../_utils/clerk-auth'
import { updateSellerProduct, type SellerProductUpdateBody } from '../../../../_utils/seller-product-update'

async function resolveOwnership(req: MedusaRequest, productId: string) {
  const clerkUserId = extractClerkUserId(req) ?? (req as any).auth_context?.actor_id
  if (!clerkUserId) return { seller: null, error: 'Authentication required', status: 401 }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (!seller) return { seller: null, error: 'Seller not found', status: 404 }

  const remoteQuery = req.scope.resolve('remoteQuery')
  const { data: rows } = await remoteQuery.graph({
    entity: 'seller',
    fields: ['id', 'products.id'],
    filters: { id: seller.id },
  })
  const productIds = ((rows?.[0] as any)?.products ?? []).map((p: any) => p.id)
  if (!productIds.includes(productId)) {
    return { seller: null, error: 'Product not found in your shop', status: 403 }
  }

  return { seller, error: null, status: 200 }
}

// PATCH /store/sellers/me/products/:id — update title, description, price, status
export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params
  const { seller, error, status } = await resolveOwnership(req, id)
  if (!seller) return res.status(status).json({ message: error })

  const result = await updateSellerProduct(req.scope, id, req.body as SellerProductUpdateBody)
  if (!result.ok) return res.status(result.status).json({ message: result.message })

  res.json({ product_id: id, updated: true })
}

// DELETE /store/sellers/me/products/:id — unpublish (draft) the product
export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params
  const { seller, error, status } = await resolveOwnership(req, id)
  if (!seller) return res.status(status).json({ message: error })

  const productService: IProductModuleService = req.scope.resolve(Modules.PRODUCT)
  await (productService as any).updateProducts({ id, status: 'draft', metadata: { deleted: true } })

  res.json({ product_id: id, deleted: true })
}
