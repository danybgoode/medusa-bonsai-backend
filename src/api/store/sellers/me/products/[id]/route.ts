import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { IProductModuleService, IPricingModuleService } from '@medusajs/framework/types'
import { updateProductsWorkflow } from '@medusajs/medusa/core-flows'
import { SELLER_MODULE } from '../../../../../../modules/seller'
import SellerModuleService from '../../../../../../modules/seller/service'
import { extractClerkUserId } from '../../../../_utils/clerk-auth'
import {
  isStockableListingType,
  resolveStockLocationId,
  setVariantAvailableQuantity,
} from '../../../../_utils/inventory'

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

  const productService: IProductModuleService = req.scope.resolve(Modules.PRODUCT)
  const pricingService: IPricingModuleService = req.scope.resolve(Modules.PRICING)
  const remoteQuery = req.scope.resolve('remoteQuery')

  const body = req.body as {
    title?: string
    description?: string | null
    price_cents?: number | null
    quantity?: number | null
    weight_grams?: number | null
    status?: 'published' | 'draft'
    attrs?: Record<string, unknown>
    metadata?: Record<string, unknown>
  }

  // ── Base product fields ────────────────────────────────────────────────────
  const baseUpdate: Record<string, unknown> = { id }
  if (body.title !== undefined) baseUpdate.title = body.title.trim().slice(0, 100)
  if (body.description !== undefined) baseUpdate.description = body.description?.trim() || null
  if (body.status !== undefined) baseUpdate.status = body.status
  if (body.weight_grams != null && body.weight_grams > 0) {
    baseUpdate.weight = Math.round(body.weight_grams)
  }

  const needsMetadataMerge = body.metadata !== undefined || body.attrs !== undefined
  if (needsMetadataMerge) {
    const { data: rows } = await remoteQuery.graph({
      entity: 'product',
      fields: ['metadata'],
      filters: { id },
    })
    const current = ((rows?.[0] as any)?.metadata ?? {}) as Record<string, unknown>
    baseUpdate.metadata = {
      ...current,
      ...(body.metadata ?? {}),
      // attrs deep-merge: overwrite only keys provided
      ...(body.attrs !== undefined
        ? { attrs: { ...((current.attrs as Record<string, unknown> | undefined) ?? {}), ...body.attrs } }
        : {}),
    }
  }

  if (Object.keys(baseUpdate).length > 1) {
    await (productService as any).updateProducts(baseUpdate)
  }

  // ── Price update ──────────────────────────────────────────────────────────
  if (body.price_cents !== undefined && body.price_cents !== null) {
    const { data: rows } = await remoteQuery.graph({
      entity: 'product',
      fields: ['variants.id', 'variants.prices.id', 'variants.prices.currency_code'],
      filters: { id },
    })
    const variant = (rows?.[0] as any)?.variants?.[0]
    const prices: Array<{ id: string; currency_code: string }> = variant?.prices ?? []
    const existing = prices.find(p => p.currency_code === 'mxn') ?? prices[0]

    if (existing?.id) {
      await (pricingService as any).updatePrices([{ id: existing.id, amount: body.price_cents }])
    } else if (variant?.id) {
      // No price yet — find price set and add one
      const { data: varRows } = await remoteQuery.graph({
        entity: 'product_variant',
        fields: ['id', 'price_set.id'],
        filters: { id: variant.id },
      })
      const priceSetId = (varRows?.[0] as any)?.price_set?.id
      if (priceSetId) {
        await (pricingService as any).addPrices([{
          price_set_id: priceSetId,
          prices: [{ amount: body.price_cents, currency_code: 'mxn', rules: {} }],
        }])
      } else {
        await updateProductsWorkflow(req.scope).run({
          input: {
            selector: { id },
            update: {
              variants: [{
                id: variant.id,
                prices: [{ amount: body.price_cents, currency_code: 'mxn' }],
              }],
            },
          },
        })
      }
    }
  }

  // ── Stock / restock (managed physical products) ────────────────────────────
  if (body.quantity !== undefined && body.quantity !== null) {
    const { data: rows } = await remoteQuery.graph({
      entity: 'product',
      fields: [
        'metadata', 'type.value',
        'variants.id', 'variants.sku', 'variants.title', 'variants.manage_inventory',
      ],
      filters: { id },
    })
    const product = rows?.[0] as any
    const listingType = product?.type?.value ?? (product?.metadata?.listing_type as string | undefined) ?? 'product'
    const variant = product?.variants?.[0] as
      | { id: string; sku?: string | null; title?: string | null; manage_inventory?: boolean }
      | undefined

    if (!isStockableListingType(listingType)) {
      return res.status(422).json({ message: 'Only physical products can have a stock quantity' })
    }
    if (variant) {
      const locationId = await resolveStockLocationId(req.scope)
      if (locationId) {
        // Ensure the variant is managed (older products may predate inventory wiring).
        if (!variant.manage_inventory) {
          await (productService as any).updateProductVariants(variant.id, { manage_inventory: true })
        }
        await setVariantAvailableQuantity(req.scope, variant, locationId, body.quantity)
      } else {
        console.error('[sellers/me/products PATCH] no stock location for quantity update', { id })
      }
    }
  }

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
