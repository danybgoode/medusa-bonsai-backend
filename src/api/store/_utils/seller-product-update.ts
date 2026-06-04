/**
 * Shared seller-product update logic (title / description / status / weight /
 * price / stock). Used by BOTH the Clerk-authed store route
 * (`/store/sellers/me/products/[id]`) and the internal service route
 * (`/internal/seller-products/[id]`, called by the seller's MCP agent) so the
 * money/inventory write path is defined once and can't drift between the two.
 *
 * Callers are responsible for authentication + ownership BEFORE calling this.
 */

import type { MedusaRequest } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { IProductModuleService, IPricingModuleService } from '@medusajs/framework/types'
import { updateProductsWorkflow } from '@medusajs/medusa/core-flows'
import {
  isStockableListingType,
  resolveStockLocationId,
  setVariantAvailableQuantity,
} from './inventory'

export interface SellerProductUpdateBody {
  title?: string
  description?: string | null
  price_cents?: number | null
  quantity?: number | null
  weight_grams?: number | null
  status?: 'published' | 'draft'
  attrs?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export type SellerProductUpdateResult = { ok: true } | { ok: false; status: number; message: string }

export async function updateSellerProduct(
  scope: MedusaRequest['scope'],
  id: string,
  body: SellerProductUpdateBody,
): Promise<SellerProductUpdateResult> {
  const productService: IProductModuleService = scope.resolve(Modules.PRODUCT)
  const pricingService: IPricingModuleService = scope.resolve(Modules.PRICING)
  const remoteQuery = scope.resolve('remoteQuery')

  // ── Base product fields ──────────────────────────────────────────────────────
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
      ...(body.attrs !== undefined
        ? { attrs: { ...((current.attrs as Record<string, unknown> | undefined) ?? {}), ...body.attrs } }
        : {}),
    }
  }

  if (Object.keys(baseUpdate).length > 1) {
    await (productService as any).updateProducts(baseUpdate)
  }

  // ── Price update ───────────────────────────────────────────────────────────
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
        await updateProductsWorkflow(scope).run({
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

  // ── Stock / restock (managed physical products) ──────────────────────────────
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
      return { ok: false, status: 422, message: 'Only physical products can have a stock quantity' }
    }
    if (variant) {
      const locationId = await resolveStockLocationId(scope)
      if (locationId) {
        if (!variant.manage_inventory) {
          await (productService as any).updateProductVariants(variant.id, { manage_inventory: true })
        }
        await setVariantAvailableQuantity(scope, variant, locationId, body.quantity)
      } else {
        console.error('[updateSellerProduct] no stock location for quantity update', { id })
      }
    }
  }

  return { ok: true }
}
