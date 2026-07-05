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
import {
  updateProductsWorkflow,
  createProductOptionsWorkflow,
  createProductVariantsWorkflow,
  deleteProductVariantsWorkflow,
  deleteProductOptionsWorkflow,
} from '@medusajs/medusa/core-flows'
import {
  isStockableListingType,
  resolveStockLocationId,
  setVariantAvailableQuantity,
  getProductAvailableQuantity,
  provisionVariantInventory,
} from './inventory'
import { generateSku, buildVariantComboKey, validateOptionDimensions } from './seller-product-create'
import { validateTierLadder, type PriceTier } from '../../../lib/price-tiers'
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
  /**
   * Add real priced option dimensions (Tamaño / Material / Acabado, up to 3)
   * to a listing that is still on the platform's auto-created single
   * "Default"/"Default" variant. Builds the full cartesian product of
   * variants via additive-only workflows — NEVER via updateProductsWorkflow
   * with a full variants/options array, which Medusa hard-deletes anything
   * omitted from the replace (verified against installed MikroORM
   * orphan-removal + Collection.set() source, 2026-07-05). The old Default
   * variant is deleted only if it has zero order line items; otherwise it's
   * disabled (manage_inventory:false + metadata.disabled:true), never
   * deleted. Rejected (422) if the product already has real dimensions —
   * restructuring an already-multi-variant product isn't supported this
   * sprint.
   */
  option_dimensions?: Array<{ title: string; values: string[] }>
  /** Per-combination price in cents (MXN), keyed by buildVariantComboKey(). Required alongside option_dimensions. */
  variant_prices?: Record<string, number>
  /**
   * Explicit variant to target for `price_cents`/`quantity`/`variant_tiers`
   * updates on a multi-variant listing. Falls back to the sole variant when
   * the product has exactly one (legacy single-variant path, unchanged).
   */
  variant_id?: string
  /**
   * Quantity price-break tiers for the targeted variant (e.g. 10→$X, 50→$Y).
   * Must cover [1, ∞) with no overlap/gap (`validateTierLadder`) — rejected
   * (422, es-MX message) otherwise. REPLACES that variant's existing prices
   * (soft-deletes them first) with the full tier ladder; a listing that never
   * sets `variant_tiers` keeps its flat `price_cents` price exactly as today.
   */
  variant_tiers?: PriceTier[]
}

export type SellerProductImage = { url: string; alt: string | null }

export type SellerProductUpdateResult =
  | { ok: true; images?: SellerProductImage[] }
  | { ok: false; status: number; message: string }

/**
 * Add priced option dimensions to a listing still on the single auto-created
 * "Default"/"Default" variant, via additive-only workflows (see the
 * `option_dimensions` doc comment above for why `updateProductsWorkflow`'s
 * full-array replace is unsafe here). Rejects if the product already has
 * real dimensions.
 */
async function applyOptionDimensions(
  scope: MedusaRequest['scope'],
  id: string,
  dimensionsRaw: Array<{ title: string; values: string[] }>,
  variantPrices: Record<string, number> | undefined,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const productService: IProductModuleService = scope.resolve(Modules.PRODUCT)
  const remoteQuery = scope.resolve('remoteQuery')

  const { data: rows } = await remoteQuery.graph({
    entity: 'product',
    fields: ['id', 'options.id', 'options.title', 'variants.id', 'variants.manage_inventory'],
    filters: { id },
  })
  const product = rows?.[0] as any
  const existingOptions: Array<{ id: string; title: string }> = product?.options ?? []
  const existingVariants: Array<{ id: string; manage_inventory?: boolean }> = product?.variants ?? []

  const isDefaultOnly =
    existingOptions.length === 1 && existingOptions[0].title === 'Default' && existingVariants.length === 1
  if (!isDefaultOnly) {
    return {
      ok: false,
      status: 422,
      message: 'Este producto ya tiene opciones configuradas; la edición de dimensiones existentes no está soportada todavía.',
    }
  }

  const validated = validateOptionDimensions(dimensionsRaw)
  if (!validated.ok) return { ok: false, status: 422, message: validated.message }
  const missingPrice = validated.combos.find((combo) => {
    const price = variantPrices?.[buildVariantComboKey(combo)]
    return !(typeof price === 'number' && price > 0)
  })
  if (missingPrice) {
    return { ok: false, status: 422, message: `Falta el precio para la combinación ${buildVariantComboKey(missingPrice)}.` }
  }

  const oldVariantId = existingVariants[0].id
  const oldOptionId = existingOptions[0].id
  const oldManageInventory = !!existingVariants[0].manage_inventory

  await createProductOptionsWorkflow(scope).run({
    input: {
      product_options: validated.dimensions.map((d) => ({ product_id: id, title: d.title, values: d.values })),
    },
  })
  await createProductVariantsWorkflow(scope).run({
    input: {
      product_variants: validated.combos.map((combo) => ({
        product_id: id,
        title: Object.values(combo).join(' / '),
        sku: generateSku(),
        options: combo,
        manage_inventory: oldManageInventory,
        prices: [{ amount: variantPrices![buildVariantComboKey(combo)], currency_code: 'mxn' }],
      })),
    },
  })

  // Re-fetch rather than trust the workflow's run() output shape — reliably
  // identifies the newly-created variant ids regardless of it.
  const { data: afterRows } = await remoteQuery.graph({
    entity: 'product',
    fields: ['id', 'variants.id'],
    filters: { id },
  })
  const afterVariantIds: string[] = ((afterRows?.[0] as any)?.variants ?? []).map((v: any) => v.id)
  const newVariantIds = afterVariantIds.filter((vid) => vid !== oldVariantId)

  if (oldManageInventory) {
    const locationId = await resolveStockLocationId(scope)
    if (locationId) {
      for (const variantId of newVariantIds) {
        await provisionVariantInventory(scope, { variantId, locationId, quantity: 0 })
      }
    } else {
      console.error('[applyOptionDimensions] no stock location — new variants left unprovisioned', { id })
    }
  }

  // Order-safety guard: never delete a variant an order line item references.
  // Soft-disable instead (hidden, non-purchasable) — the option itself is
  // left in place too since the disabled variant still references it.
  const orderService: any = scope.resolve(Modules.ORDER)
  const referencingOrders = await orderService.listOrderLineItems({ variant_id: oldVariantId }, { take: 1 })
  if (Array.isArray(referencingOrders) && referencingOrders.length > 0) {
    await (productService as any).updateProductVariants(oldVariantId, {
      manage_inventory: false,
      metadata: { disabled: true },
    })
  } else {
    await deleteProductVariantsWorkflow(scope).run({ input: { ids: [oldVariantId] } })
    await deleteProductOptionsWorkflow(scope).run({ input: { ids: [oldOptionId] } })
  }

  return { ok: true }
}

export async function updateSellerProduct(
  scope: MedusaRequest['scope'],
  id: string,
  body: SellerProductUpdateBody,
): Promise<SellerProductUpdateResult> {
  const productService: IProductModuleService = scope.resolve(Modules.PRODUCT)
  const pricingService: IPricingModuleService = scope.resolve(Modules.PRICING)
  const remoteQuery = scope.resolve('remoteQuery')

  // ── Priced option dimensions (print-configurator listings) ───────────────
  if (body.option_dimensions !== undefined) {
    const result = await applyOptionDimensions(scope, id, body.option_dimensions, body.variant_prices)
    if (!result.ok) return result
  }

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
    const variants: any[] = (rows?.[0] as any)?.variants ?? []
    const variant = body.variant_id
      ? variants.find((v) => v.id === body.variant_id)
      : variants.length <= 1 ? variants[0] : undefined
    if (!variant) {
      return variants.length > 1
        ? { ok: false, status: 422, message: 'Este producto tiene varias variantes; especifica variant_id.' }
        : { ok: false, status: 404, message: 'variant_id no encontrado en este producto.' }
    }
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
        // Single-variant field update — NEVER route this through
        // updateProductsWorkflow's `variants` array, which does a full
        // Collection.set() replace at the Product level and hard-deletes any
        // sibling variant omitted from the array (verified 2026-07-05; see
        // the option_dimensions doc comment above).
        await (productService as any).updateProductVariants(variant.id, {
          prices: [{ amount: body.price_cents, currency_code: 'mxn' }],
        })
      }
    }
  }

  // ── Quantity price-break tiers ────────────────────────────────────────────
  if (body.variant_tiers !== undefined) {
    const validated = validateTierLadder(body.variant_tiers)
    if (!validated.ok) return { ok: false, status: 422, message: validated.message }

    const { data: rows } = await remoteQuery.graph({
      entity: 'product',
      fields: ['variants.id', 'variants.prices.id', 'variants.prices.currency_code'],
      filters: { id },
    })
    const variants: any[] = (rows?.[0] as any)?.variants ?? []
    const variant = body.variant_id
      ? variants.find((v) => v.id === body.variant_id)
      : variants.length <= 1 ? variants[0] : undefined
    if (!variant) {
      return variants.length > 1
        ? { ok: false, status: 422, message: 'Este producto tiene varias variantes; especifica variant_id.' }
        : { ok: false, status: 404, message: 'variant_id no encontrado en este producto.' }
    }

    const { data: varRows } = await remoteQuery.graph({
      entity: 'product_variant',
      fields: ['id', 'price_set.id'],
      filters: { id: variant.id },
    })
    const priceSetId = (varRows?.[0] as any)?.price_set?.id
    if (!priceSetId) {
      return { ok: false, status: 422, message: 'Esta variante no tiene un conjunto de precios; agrega un precio primero.' }
    }

    // Replace: soft-delete the variant's existing MXN prices (the flat
    // no-tier price included), then add the full tier ladder — avoids two
    // simultaneously-matching MXN prices for the same quantity.
    const existingMxnPriceIds: string[] = ((variant.prices ?? []) as Array<{ id: string; currency_code: string }>)
      .filter((p) => p.currency_code === 'mxn')
      .map((p) => p.id)
    if (existingMxnPriceIds.length > 0) {
      await (pricingService as any).softDeletePrices(existingMxnPriceIds)
    }
    await (pricingService as any).addPrices([{
      price_set_id: priceSetId,
      prices: body.variant_tiers.map((tier) => ({
        amount: tier.amount,
        currency_code: 'mxn',
        min_quantity: tier.min_quantity,
        max_quantity: tier.max_quantity,
        rules: {},
      })),
    }])
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
    const variants: any[] = product?.variants ?? []
    const variant = (body.variant_id
      ? variants.find((v) => v.id === body.variant_id)
      : variants.length <= 1 ? variants[0] : undefined) as
      | { id: string; sku?: string | null; title?: string | null; manage_inventory?: boolean }
      | undefined

    if (!isStockableListingType(listingType)) {
      return { ok: false, status: 422, message: 'Only physical products can have a stock quantity' }
    }
    if (!variant && variants.length > 1) {
      return { ok: false, status: 422, message: 'Este producto tiene varias variantes; especifica variant_id.' }
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
