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

// GET /store/sellers/me/products/:id — seller-scoped per-variant read.
// Exists because COGS (`variant.metadata.unit_cost_cents`) is seller-private:
// the public /store/listings + price-grid reads must never carry it, so the
// edit UI reads current costs here (profit-analyzer S1 · US-1).
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params
  const { seller, error, status } = await resolveOwnership(req, id)
  if (!seller) return res.status(status).json({ message: error })

  const remoteQuery = req.scope.resolve('remoteQuery')
  const { data: rows } = await remoteQuery.graph({
    entity: 'product',
    fields: ['id', 'variants.id', 'variants.title', 'variants.metadata'],
    filters: { id },
  })
  const variants = (((rows?.[0] as any)?.variants ?? []) as any[]).map((v) => {
    const meta = (v?.metadata as Record<string, unknown> | null)
    const cost = meta?.unit_cost_cents
    const mlPrice = meta?.ml_price_cents
    return {
      id: v.id as string,
      title: (v.title as string | null) ?? null,
      unit_cost_cents: typeof cost === 'number' && Number.isInteger(cost) && cost >= 0 ? cost : null,
      // ML price override (catalog-management S2 · 2.3) — seller-private, same
      // shape/validation as unit_cost_cents.
      ml_price_cents: typeof mlPrice === 'number' && Number.isInteger(mlPrice) && mlPrice >= 0 ? mlPrice : null,
    }
  })
  res.json({ product_id: id, variants })
}

// PATCH /store/sellers/me/products/:id — update title, description, price, status
export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params
  const { seller, error, status } = await resolveOwnership(req, id)
  if (!seller) return res.status(status).json({ message: error })

  const result = await updateSellerProduct(
    req.scope, id, req.body as SellerProductUpdateBody, { id: seller.id, slug: seller.slug },
  )
  if (!result.ok) return res.status(result.status).json({ message: result.message })

  res.json({ product_id: id, updated: true })
}

// DELETE /store/sellers/me/products/:id — soft-delete the product
export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params
  const { seller, error, status } = await resolveOwnership(req, id)
  if (!seller) return res.status(status).json({ message: error })

  const productService: IProductModuleService = req.scope.resolve(Modules.PRODUCT)
  // Native Medusa soft-delete — sets deleted_at, so the product drops out of
  // GET /store/sellers/me/products and /store/listings (both query the product
  // entity, which excludes deleted_at by default) while keeping the row so past
  // order line-items still resolve. Never the merged-object updateProducts
  // selector form (LEARNINGS → Medusa gotchas); soft-delete is the single source
  // of truth for "deleted".
  await productService.softDeleteProducts([id])

  res.json({ product_id: id, deleted: true })
}
