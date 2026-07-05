/**
 * Shared seller-product CREATE logic (Medusa product workflow + seller link +
 * inventory provisioning). Used by BOTH the Clerk-authed store route
 * (`POST /store/sellers/me/products`) and the internal service route
 * (`POST /internal/seller-products`, called by the seller's MCP agent) so the
 * product-create path is defined once and can't drift between the two — the
 * create counterpart of `seller-product-update.ts`.
 *
 * Callers are responsible for authentication + resolving the seller BEFORE
 * calling this; this function trusts `sellerId`.
 */

import type { MedusaRequest } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { IProductModuleService } from '@medusajs/framework/types'
import { createProductsWorkflow } from '@medusajs/medusa/core-flows'
import { SELLER_MODULE } from '../../../modules/seller'
import {
  isStockableListingType,
  resolveStockLocationId,
  provisionVariantInventory,
} from './inventory'
import { resolveDefaultShippingProfileId } from './fulfillment'

/** Auto-generate a unique SKU for P2P marketplace items. */
export function generateSku(): string {
  const ts = Date.now().toString(36).toUpperCase()
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase()
  return `MIYAGI-${ts}-${rand}`
}

export interface CreateProductBody {
  title: string
  description?: string | null
  price_cents?: number | null
  currency?: string
  condition?: string | null
  listing_type?: string
  category?: string       // category handle
  state?: string | null
  municipio?: string | null
  location?: string | null
  quantity?: number | null
  weight_grams?: number | null
  /** Initial publish state. Defaults to 'published' (preserves prior behaviour). */
  status?: 'published' | 'draft'
  images?: Array<{ url: string; alt?: string }>
  tags?: string[]
  attrs?: Record<string, unknown>  // type/category-specific attributes (brand, size, color…)
  metadata?: Record<string, unknown>
  /**
   * Priced option dimensions (Tamaño / Material / Acabado, up to 3) for a
   * print-configurator listing. When present, replaces the single
   * "Default"/"Default" variant with the full cartesian product of
   * combinations, each priced via `variant_prices`. Omit for a normal
   * single-variant listing (unchanged default behaviour).
   */
  option_dimensions?: Array<{ title: string; values: string[] }>
  /**
   * Per-combination price in cents (MXN), keyed by `buildVariantComboKey()`
   * (sorted "Title:Value|Title:Value"). Required for every combination when
   * `option_dimensions` is set.
   */
  variant_prices?: Record<string, number>
}

const MAX_OPTION_DIMENSIONS = 3
const MAX_VARIANT_COMBOS = 60

/** Stable, sorted combo key so callers can address a specific variant's price. */
export function buildVariantComboKey(combo: Record<string, string>): string {
  return Object.keys(combo)
    .sort()
    .map((title) => `${title}:${combo[title]}`)
    .join('|')
}

/** Cartesian product of option dimensions → one combo (Title→value map) per variant. */
export function cartesianCombos(
  dimensions: Array<{ title: string; values: string[] }>,
): Array<Record<string, string>> {
  return dimensions.reduce<Array<Record<string, string>>>(
    (combos, dim) =>
      combos.flatMap((combo) => dim.values.map((value) => ({ ...combo, [dim.title]: value }))),
    [{}],
  )
}

export type ValidatedDimensionsResult =
  | { ok: true; dimensions: Array<{ title: string; values: string[] }>; combos: Array<Record<string, string>> }
  | { ok: false; message: string }

/**
 * Validate seller-supplied option dimensions: 1-3 dimensions, non-empty
 * trimmed titles/values, no duplicate titles, no duplicate values within a
 * dimension, and a bounded combo count (guards against an accidental
 * combinatorial explosion, e.g. 3 dimensions × 20 values each).
 */
export function validateOptionDimensions(
  raw: Array<{ title: string; values: string[] }>,
): ValidatedDimensionsResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: 'Se requiere al menos una dimensión de opción (por ejemplo, Tamaño).' }
  }
  if (raw.length > MAX_OPTION_DIMENSIONS) {
    return { ok: false, message: `Máximo ${MAX_OPTION_DIMENSIONS} dimensiones de opción (por ejemplo, Tamaño, Material, Acabado).` }
  }
  const dimensions: Array<{ title: string; values: string[] }> = []
  const seenTitles = new Set<string>()
  for (const dim of raw) {
    const title = dim?.title?.trim().slice(0, 40)
    if (!title) return { ok: false, message: 'Cada dimensión necesita un nombre (por ejemplo, Tamaño).' }
    const titleKey = title.toLowerCase()
    if (seenTitles.has(titleKey)) {
      return { ok: false, message: `La dimensión "${title}" está repetida.` }
    }
    seenTitles.add(titleKey)

    const seenValues = new Set<string>()
    const values: string[] = []
    for (const raw of dim.values ?? []) {
      const value = raw?.trim().slice(0, 40)
      if (!value) continue
      const valueKey = value.toLowerCase()
      if (seenValues.has(valueKey)) continue
      seenValues.add(valueKey)
      values.push(value)
    }
    if (values.length === 0) {
      return { ok: false, message: `La dimensión "${title}" necesita al menos un valor.` }
    }
    dimensions.push({ title, values })
  }

  const combos = cartesianCombos(dimensions)
  if (combos.length > MAX_VARIANT_COMBOS) {
    return { ok: false, message: `Demasiadas combinaciones (${combos.length}). Máximo ${MAX_VARIANT_COMBOS} — reduce el número de dimensiones o valores.` }
  }
  return { ok: true, dimensions, combos }
}

export type CreateSellerProductResult =
  | { ok: true; product_id: string }
  | { ok: false; status: number; message: string }

/**
 * Create a Medusa product for the given seller and link it. Returns the new
 * product id, or a structured error the caller maps to an HTTP status.
 */
export async function createSellerProduct(
  scope: MedusaRequest['scope'],
  sellerId: string,
  body: CreateProductBody,
): Promise<CreateSellerProductResult> {
  const productService: IProductModuleService = scope.resolve(Modules.PRODUCT)
  const remoteLink = scope.resolve(ContainerRegistrationKeys.LINK)

  if (!body.title?.trim() || body.title.trim().length < 3) {
    return { ok: false, status: 400, message: 'title must be at least 3 characters' }
  }

  // ── Priced option dimensions (print-configurator listings) ────────────────
  let dimensions: Array<{ title: string; values: string[] }> | undefined
  let dimensionCombos: Array<Record<string, string>> | undefined
  if (body.option_dimensions !== undefined) {
    const validated = validateOptionDimensions(body.option_dimensions)
    if (!validated.ok) return { ok: false, status: 422, message: validated.message }
    const missingPrice = validated.combos.find((combo) => {
      const price = body.variant_prices?.[buildVariantComboKey(combo)]
      return !(typeof price === 'number' && price > 0)
    })
    if (missingPrice) {
      return { ok: false, status: 422, message: `Falta el precio para la combinación ${buildVariantComboKey(missingPrice)}.` }
    }
    dimensions = validated.dimensions
    dimensionCombos = validated.combos
  }

  // ── Look up category by handle ──────────────────────────────────────────
  let categoryId: string | undefined
  if (body.category) {
    const [cat] = await productService.listProductCategories({ handle: body.category })
    categoryId = cat?.id
  }

  // ── Look up product type by value ────────────────────────────────────────
  const typeValue = body.listing_type ?? 'physical'
  const [ptype] = await productService.listProductTypes({ value: typeValue })

  // ── Build metadata ───────────────────────────────────────────────────────
  const metadata: Record<string, unknown> = {
    ...(body.condition ? { condition: body.condition } : {}),
    ...(body.state ? { state: body.state } : {}),
    ...(body.municipio ? { municipio: body.municipio } : {}),
    ...(body.location ? { location: body.location } : {}),
    ...(body.price_cents != null ? { price_cents: body.price_cents } : {}),
    currency: body.currency ?? 'MXN',
    listing_type: body.listing_type ?? 'product',
    views: 0,
    // Category/type-specific structured attributes (brand, size, color, year, km…)
    ...(body.attrs && Object.keys(body.attrs).length > 0 ? { attrs: body.attrs } : {}),
    ...(body.metadata ?? {}),
  }

  // ── Resolve the sales channel ────────────────────────────────────────────
  // The product MUST be in the store's sales channel, otherwise the standard
  // (channel-scoped) /store/products endpoint 404s and checkout fails with
  // "Product not found" even though the custom /store/listings endpoint shows it.
  let salesChannelId: string | undefined = process.env.MEDUSA_SALES_CHANNEL_ID || undefined
  if (!salesChannelId) {
    try {
      const storeService: any = scope.resolve(Modules.STORE)
      const [store] = await storeService.listStores({}, { select: ['default_sales_channel_id'], take: 1 })
      salesChannelId = store?.default_sales_channel_id ?? undefined
    } catch (e) {
      console.error('[createSellerProduct] sales channel resolve failed:', e)
    }
  }

  // ── Inventory: physical `product` listings are unique-stock items ─────────
  // Managed variants let Medusa's completeCartWorkflow reserve stock on order
  // placement and block double-selling. service/rental/digital/subscription are
  // not stockable. Default quantity 1 (unique P2P item).
  const manageInventory = isStockableListingType(body.listing_type)
  const quantity = Math.max(0, Math.floor(body.quantity ?? 1))
  const sku = generateSku()
  const weightGrams = body.weight_grams != null && body.weight_grams > 0
    ? Math.round(body.weight_grams)
    : undefined

  // ── Resolve the shipping profile ─────────────────────────────────────────
  // Medusa requires every product to belong to a shipping profile; the cart's
  // shipping method must be on the SAME profile or completeCart rejects the order
  // ("shipping profiles not satisfied"). Link to the canonical default profile —
  // the same one the seeded shipping options use.
  const shippingProfileId = await resolveDefaultShippingProfileId(scope)

  // ── Create Medusa product ────────────────────────────────────────────────
  const { result } = await createProductsWorkflow(scope).run({
    input: {
      products: [{
        title: body.title.trim().slice(0, 100),
        description: body.description?.trim() || null,
        status: body.status ?? 'published',
        ...(weightGrams !== undefined ? { weight: weightGrams } : {}),
        ...(shippingProfileId ? { shipping_profile_id: shippingProfileId } : {}),
        ...(salesChannelId ? { sales_channels: [{ id: salesChannelId }] } : {}),
        ...(categoryId ? { category_ids: [categoryId] } : {}),
        ...(ptype ? { type_id: ptype.id } : {}),
        images: (body.images ?? []).map((img) => ({
          url: img.url,
          metadata: img.alt ? { alt: img.alt } : undefined,
        })),
        options: dimensions ?? [{
          title: 'Default',
          values: ['Default'],
        }],
        metadata,
        variants: dimensionCombos
          ? dimensionCombos.map((combo) => ({
              title: Object.values(combo).join(' / '),
              sku: generateSku(),
              options: combo,
              manage_inventory: manageInventory,
              prices: [{
                amount: body.variant_prices![buildVariantComboKey(combo)],
                currency_code: (body.currency ?? 'MXN').toLowerCase(),
              }],
            }))
          : [{
              // Use the product title as the variant title so Admin shows meaningful names
              // instead of "Default". P2P items are unique, so there's always one variant.
              title: body.title.trim().slice(0, 100),
              sku,
              options: {
                Default: 'Default',
              },
              manage_inventory: manageInventory,
              prices: body.price_cents != null && body.price_cents > 0
                ? [{ amount: body.price_cents, currency_code: (body.currency ?? 'MXN').toLowerCase() }]
                : [],
            }],
      }],
    },
  })
  const product = result[0]

  // ── Link product to seller ───────────────────────────────────────────────
  await remoteLink.create({
    [SELLER_MODULE]: { seller_id: sellerId },
    [Modules.PRODUCT]: { product_id: product.id },
  })

  // ── Provision inventory level for managed (physical) products ─────────────
  // The managed variant's inventory item is auto-created by the product workflow;
  // here we create the stock level at the seeded location and ensure that location
  // is linked to the sales channel so reservations succeed on order placement.
  if (manageInventory) {
    const variantIds = ((product.variants ?? []) as { id?: string }[])
      .map((v) => v.id)
      .filter((id): id is string => !!id)
    const locationId = await resolveStockLocationId(scope)
    if (variantIds.length > 0 && locationId) {
      for (const variantId of variantIds) {
        await provisionVariantInventory(scope, {
          variantId,
          salesChannelId,
          locationId,
          quantity,
        })
      }
    } else {
      console.error('[createSellerProduct] inventory not provisioned:', { variantIds, locationId })
    }
  }

  return { ok: true, product_id: product.id }
}
