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
function generateSku(): string {
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
        options: [{
          title: 'Default',
          values: ['Default'],
        }],
        metadata,
        variants: [{
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
    const variantId = (product.variants?.[0] as { id?: string } | undefined)?.id
    const locationId = await resolveStockLocationId(scope)
    if (variantId && locationId) {
      await provisionVariantInventory(scope, {
        variantId,
        salesChannelId,
        locationId,
        quantity,
      })
    } else {
      console.error('[createSellerProduct] inventory not provisioned:', { variantId, locationId })
    }
  }

  return { ok: true, product_id: product.id }
}
