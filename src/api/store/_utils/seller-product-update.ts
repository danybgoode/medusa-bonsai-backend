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
  getProductAvailableQuantity,
} from './inventory'
import { isEnabled } from '../../../lib/flags'
import { MERCADOLIBRE_MODULE } from '../../../modules/mercadolibre'
import MercadolibreModuleService from '../../../modules/mercadolibre/service'

export interface SellerProductUpdateBody {
  title?: string
  description?: string | null
  price_cents?: number | null
  quantity?: number | null
  weight_grams?: number | null
  status?: 'published' | 'draft'
  attrs?: Record<string, unknown>
  metadata?: Record<string, unknown>
  /**
   * Replace or extend the product's image set. `images_mode` defaults to
   * 'append' (merge with the existing images, de-duped by URL); 'replace' swaps
   * the whole set. Powers the supply image-backfill path so older one-photo gems
   * can grow a real gallery without re-importing.
   */
  images?: Array<{ url: string; alt?: string | null }>
  images_mode?: 'append' | 'replace'
}

export type SellerProductImage = { url: string; alt: string | null }

export type SellerProductUpdateResult =
  | { ok: true; images?: SellerProductImage[] }
  | { ok: false; status: number; message: string }

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

  // ── Images (append / replace, de-duped by URL) ───────────────────────────────
  // Computed up front so the final set rides along in the single updateProducts
  // call below AND can be returned to the caller for mirroring.
  let finalImages: SellerProductImage[] | undefined
  if (body.images !== undefined) {
    const mode = body.images_mode === 'replace' ? 'replace' : 'append'

    const incoming: SellerProductImage[] = (body.images ?? [])
      .filter((img) => img && typeof img.url === 'string' && img.url.trim())
      .map((img) => ({ url: img.url.trim(), alt: img.alt ?? null }))

    let existing: SellerProductImage[] = []
    if (mode === 'append') {
      const { data: rows } = await remoteQuery.graph({
        entity: 'product',
        fields: ['images.url', 'images.metadata'],
        filters: { id },
      })
      existing = (((rows?.[0] as any)?.images ?? []) as Array<{ url: string; metadata?: any }>)
        .filter((img) => img?.url)
        .map((img) => ({ url: img.url, alt: (img.metadata?.alt as string | undefined) ?? null }))
    }

    // De-dupe by URL, first occurrence wins → existing images keep their order
    // and alt; only genuinely new URLs are appended.
    const seen = new Set<string>()
    finalImages = [...existing, ...incoming].filter((img) => {
      if (seen.has(img.url)) return false
      seen.add(img.url)
      return true
    })
  }

  if (Object.keys(baseUpdate).length > 1) {
    // Update by id with the explicit (id, data) form. Passing a single merged
    // object makes Medusa treat it as a SELECTOR (matching on title/description/
    // metadata), which never matches the stored row once metadata carries
    // custom_fields → the save 500s ("unknown error") or silently no-ops.
    const { id: _productId, ...productData } = baseUpdate
    await (productService as any).updateProducts(id, productData)
  }

  // ── Image set replace (via the workflow, like create) ────────────────────────
  // Images go through updateProductsWorkflow (not productService.updateProducts)
  // because the workflow owns the image-relation replace the same way
  // createProductsWorkflow seeds it; passing `images` swaps the whole set, which
  // is why `finalImages` already carries the merged 'append' result.
  if (finalImages !== undefined) {
    await updateProductsWorkflow(scope).run({
      input: {
        selector: { id },
        update: {
          images: finalImages.map((img) => ({
            url: img.url,
            ...(img.alt ? { metadata: { alt: img.alt } } : {}),
          })),
        },
      },
    })
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
        // Propagate a manual stock edit to a linked ML item (US-10) so ML never
        // oversells. Push the product's *summed* available (across variants), not
        // the single edited variant's quantity, so a multi-variant product doesn't
        // understate ML stock. Best-effort + flag-gated; the per-seller enable +
        // linkage + idempotency + rate-limit deferral all live inside pushStockToMl.
        try {
          if (await isEnabled('ml.sync_enabled')) {
            const ml = scope.resolve(MERCADOLIBRE_MODULE) as MercadolibreModuleService
            const available = await getProductAvailableQuantity(scope, id)
            if (available != null) await ml.pushStockToMl({ productId: id, availableQuantity: available })
          }
        } catch (e) {
          console.error('[updateSellerProduct] ML stock push failed', id, e)
        }
      } else {
        console.error('[updateSellerProduct] no stock location for quantity update', { id })
      }
    }
  }

  return { ok: true, images: finalImages }
}
