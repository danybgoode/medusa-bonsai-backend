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
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
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
import { splitCategories } from './category-split'
import { resolveOwnedCollectionIds } from './seller-collections'

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
   * "Default"/"Default" variant. Deletes the old Default variant + option
   * (proper cleanup, via deleteProductVariantsWorkflow +
   * deleteProductOptionsWorkflow) then builds the full cartesian product of
   * new variants via additive-only workflows — NEVER via
   * updateProductsWorkflow with a full variants/options array, which Medusa
   * hard-deletes anything omitted from the replace with no cross-module link
   * cleanup (verified against installed MikroORM orphan-removal +
   * Collection.set() source, 2026-07-05). The old Default option MUST be
   * deleted before the new variants are created — Medusa requires every new
   * variant's options map to cover the product's full CURRENT option set
   * (verified against @medusajs/product's assignOptionsToVariants,
   * 2026-07-05 cross-agent review catch — creating a variant with only the
   * new dimensions while "Default" is still attached throws INVALID_DATA).
   * Order-safety guard: since that means the old variant can never be
   * preserved once this runs, the whole operation is REFUSED (422) if the
   * old variant has any order line items — a fresh/unsold listing (the
   * normal case) converts; one with sales history needs a new listing
   * instead. Also rejected (422) if the product already has real
   * dimensions — restructuring an already-multi-variant product isn't
   * supported this sprint.
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
  /**
   * Unit cost (COGS) in integer centavos MXN for the targeted variant
   * (`variant_id`, or the sole variant — same resolution as `price_cents`).
   * Stored on `variant.metadata.unit_cost_cents`, which is seller-private:
   * the public listing/price-grid reads never surface variant metadata cost,
   * only the seller-scoped GET does. `null` clears it. The profit ledger
   * snapshots this at sale time, so a later edit never rewrites history
   * (profit-analyzer S1 · US-1).
   */
  unit_cost_cents?: number | null
  /**
   * Full replacement set of seller-owned collection ids this product should
   * belong to (own-shop-premium-presentation S2). Requires the `seller`
   * context param on `updateSellerProduct` (the seller-UI + MCP-agent call
   * sites already resolve it) — every id is intersected against
   * `resolveOwnedCollectionIds` so a request can never attach a product to
   * another seller's collection, and the product's platform-taxonomy
   * category (if any) is always preserved untouched.
   */
  collection_ids?: string[]
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

  // Order-safety guard — checked FIRST, before any mutation, and now a hard
  // refusal rather than an in-place restructure. Verified against
  // @medusajs/product/dist/services/product-module-service.js's
  // `assignOptionsToVariants` (2026-07-05, cross-agent review catch): Medusa
  // requires every variant passed to createVariants_/updateVariants_ to
  // specify a value for EVERY option currently attached to the product — so
  // the new Tamaño/Material variants literally cannot be created while the
  // old "Default" option is still attached, meaning "Default" must always be
  // deleted before creating them. That makes preserving the old variant
  // (this sprint's original soft-disable design) impossible to do safely in
  // the same stroke, so a listing with any order history is refused outright
  // (422) instead — "safe" means never risking data loss, not "always
  // possible." A fresh/unsold listing (the common case for a new print-
  // configurator conversion) converts normally.
  const orderService: any = scope.resolve(Modules.ORDER)
  const referencingOrders = await orderService.listOrderLineItems({ variant_id: oldVariantId }, { take: 1 })
  if (Array.isArray(referencingOrders) && referencingOrders.length > 0) {
    return {
      ok: false,
      status: 422,
      message: 'Este anuncio ya tiene pedidos; no se puede convertir a variantes múltiples. Crea un nuevo anuncio para la versión con opciones.',
    }
  }

  // No orders — safe to fully replace. The old variant + "Default" option
  // must be deleted BEFORE creating the new ones (see the constraint above);
  // both delete workflows do the proper remote-link + inventory-item
  // cleanup (unlike updateProductsWorkflow's array-replace hard-delete).
  await deleteProductVariantsWorkflow(scope).run({ input: { ids: [oldVariantId] } })
  await deleteProductOptionsWorkflow(scope).run({ input: { ids: [oldOptionId] } })

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

  if (oldManageInventory) {
    // Re-fetch rather than trust the workflow's run() output shape — every
    // variant on the product is new at this point (the old one was deleted
    // above), so no id-diffing is needed.
    const { data: afterRows } = await remoteQuery.graph({
      entity: 'product',
      fields: ['id', 'variants.id'],
      filters: { id },
    })
    const newVariantIds: string[] = ((afterRows?.[0] as any)?.variants ?? []).map((v: any) => v.id)
    const locationId = await resolveStockLocationId(scope)
    if (locationId) {
      for (const variantId of newVariantIds) {
        await provisionVariantInventory(scope, { variantId, locationId, quantity: 0 })
      }
    } else {
      console.error('[applyOptionDimensions] no stock location — new variants left unprovisioned', { id })
    }
  }

  return { ok: true }
}

export async function updateSellerProduct(
  scope: MedusaRequest['scope'],
  id: string,
  body: SellerProductUpdateBody,
  seller?: { id: string; slug: string },
): Promise<SellerProductUpdateResult> {
  const productService: IProductModuleService = scope.resolve(Modules.PRODUCT)
  const pricingService: IPricingModuleService = scope.resolve(Modules.PRICING)
  const remoteQuery = scope.resolve('remoteQuery')

  // A caller can't know the newly-created variant ids until AFTER
  // option_dimensions commits, so combining it with price_cents/quantity/
  // variant_tiers (all of which resolve to a specific variant_id, or the
  // sole variant when exactly one exists) in the SAME request would let the
  // dimensions mutation succeed and then 422 on the price/stock/tiers block
  // — a confusing "did it work?" response after a real mutation already
  // landed (cross-agent review catch, 2026-07-05 — the original guard
  // missed variant_tiers, a second review pass caught that gap). Reject
  // upfront instead: set per-combination prices via variant_prices at
  // dimension-creation time, and stock/tiers in a separate follow-up call
  // (re-fetch the price-grid for the new variant ids first).
  if (body.option_dimensions !== undefined
    && (body.price_cents !== undefined || body.quantity !== undefined || body.variant_tiers !== undefined
      || body.unit_cost_cents !== undefined)) {
    return {
      ok: false,
      status: 422,
      message: 'No combines option_dimensions con price_cents/quantity/variant_tiers/unit_cost_cents en la misma solicitud. Usa variant_prices para los precios; el stock, los niveles y el costo se ajustan en una solicitud aparte con variant_id.',
    }
  }

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

  // ── Collection assignment (own-shop-premium-presentation S2) ─────────────
  if (body.collection_ids !== undefined) {
    if (!seller) {
      return { ok: false, status: 422, message: 'collection_ids requiere contexto de vendedor.' }
    }
    const { data: rows } = await remoteQuery.graph({
      entity: 'product',
      fields: ['categories.id', 'categories.handle'],
      filters: { id },
    })
    const currentCategories = ((rows?.[0] as any)?.categories ?? []) as Array<{ id: string; handle: string }>
    const { platformCategory } = splitCategories(currentCategories, seller.slug)
    const ownedIds = await resolveOwnedCollectionIds(scope, seller.id)
    // A foreign/typo/deleted id is REJECTED outright (422), not silently
    // dropped — a partial-success write here would let a seller believe a
    // product was assigned to a collection when the id was actually
    // discarded (cross-agent review catch, 2026-07-07).
    const unknownIds = body.collection_ids.filter((cid) => !ownedIds.has(cid))
    if (unknownIds.length > 0) {
      return {
        ok: false,
        status: 422,
        message: `Colección(es) no válida(s) o no pertenecen a tu tienda: ${unknownIds.join(', ')}`,
      }
    }
    baseUpdate.category_ids = [
      ...(platformCategory ? [platformCategory.id] : []),
      ...body.collection_ids,
    ]
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
    const mxnPrices = prices.filter(p => p.currency_code === 'mxn')
    // A variant with quantity tiers (Story 2.2) carries MULTIPLE mxn prices.
    // Silently picking one via .find() and overwriting only that tier would
    // corrupt the ladder (the other tiers keep stale amounts) — reject
    // instead and point at the right tool (cross-agent review catch,
    // 2026-07-05).
    if (mxnPrices.length > 1) {
      return {
        ok: false,
        status: 422,
        message: 'Esta variante tiene niveles de precio por cantidad; usa variant_tiers para actualizarlos, no price_cents.',
      }
    }
    const existing = mxnPrices[0] ?? prices[0]

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
        // The variant has no price_set at all (edge case). Two unsafe paths
        // ruled out here: updateProductsWorkflow's `variants` array does a
        // full Collection.set() replace at the Product level and hard-
        // deletes any sibling variant omitted from the array (verified
        // 2026-07-05; see the option_dimensions doc comment above); and
        // productService.updateProductVariants()'s UpdateProductVariantDTO
        // has NO `prices` field at all (confirmed against
        // @medusajs/types/dist/product/common.d.ts) — it would silently
        // drop the payload with no error, a cross-agent review catch
        // (2026-07-05). Create a fresh price set and link it via the exact
        // remote-link shape Medusa's own createVariantPricingLinkStep uses
        // (@medusajs/core-flows/dist/product/steps/create-variant-pricing-link.js).
        const newPriceSet = await (pricingService as any).createPriceSets({
          prices: [{ amount: body.price_cents, currency_code: 'mxn', rules: {} }],
        })
        const remoteLink = scope.resolve(ContainerRegistrationKeys.LINK)
        await remoteLink.create({
          [Modules.PRODUCT]: { variant_id: variant.id },
          [Modules.PRICING]: { price_set_id: newPriceSet.id },
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

  // ── Unit cost (COGS) — variant.metadata.unit_cost_cents ──────────────────
  if (body.unit_cost_cents !== undefined) {
    if (body.unit_cost_cents !== null
      && (!Number.isInteger(body.unit_cost_cents) || body.unit_cost_cents < 0)) {
      return { ok: false, status: 422, message: 'El costo unitario debe ser un entero en centavos de 0 o más.' }
    }
    const { data: rows } = await remoteQuery.graph({
      entity: 'product',
      fields: ['variants.id', 'variants.metadata'],
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
    // Read-merge-write on the variant metadata (same discipline as the
    // product-level metadata merge above) so sibling keys like `disabled`
    // survive; null deletes the key rather than storing a null.
    const currentMeta = ((variant.metadata ?? {}) as Record<string, unknown>)
    const nextMeta: Record<string, unknown> = { ...currentMeta }
    if (body.unit_cost_cents === null) delete nextMeta.unit_cost_cents
    else nextMeta.unit_cost_cents = body.unit_cost_cents
    await (productService as any).updateProductVariants(variant.id, { metadata: nextMeta })
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
