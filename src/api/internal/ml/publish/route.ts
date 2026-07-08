/**
 * Internal service route — publish / sync a Miyagi product to Mercado Libre
 * (Sprint 3 · US-7 + US-8). Reads the Medusa product (the source of truth),
 * verifies it belongs to the seller, normalises it via the shared listing
 * normaliser, then runs the module's reconcile seam (create / update / close /
 * relist) and persists the linkage. The seller's ML token is materialised only
 * inside the module and never crosses this boundary.
 *
 *   POST /internal/ml/publish
 *     body: { seller_slug, product_id, category_id?, variant_id? }
 *     → { action, created, ml_item_id, permalink, status }
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { MERCADOLIBRE_MODULE } from '../../../../modules/mercadolibre'
import MercadolibreModuleService from '../../../../modules/mercadolibre/service'
import { toListingShape } from '../../../store/_utils/listing'
import type { MlPublishInput } from '../../../../modules/mercadolibre/_utils'
import { resolveMlOrdersEntitlement } from '../../../../lib/ml-orders-entitlement'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { seller_slug, product_id, category_id, variant_id, action } = (req.body ?? {}) as {
    seller_slug?: string
    product_id?: string
    category_id?: string | null
    variant_id?: string | null
    action?: string
  }
  if (!seller_slug || !product_id) {
    return res.status(400).json({ message: 'seller_slug and product_id required' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug: seller_slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const ml: MercadolibreModuleService = req.scope.resolve(MERCADOLIBRE_MODULE)

  // Best-effort close (archive/delete hook): keyed off the linkage only, so it
  // works even after the Medusa product is soft-deleted/unreadable.
  if (action === 'close') {
    try {
      const result = await ml.closeProductMl(seller.id, product_id)
      await ml.recordSyncEvent({
        sellerId: seller.id,
        kind: 'close',
        outcome: 'ok',
        productId: product_id,
        mlItemId: result.ml_item_id,
        code: result.action,
        message: result.action === 'noop' ? 'Sin cambios (ya cerrado / sin vínculo)' : 'Publicación cerrada en Mercado Libre',
      })
      return res.status(200).json(result)
    } catch (e) {
      const err = e as { code?: string; message?: string }
      await ml.recordSyncEvent({
        sellerId: seller.id, kind: 'close', outcome: 'fail', productId: product_id,
        code: err.code ?? null, message: err.message,
      })
      if (err.code === 'ML_REAUTH_REQUIRED') return res.status(409).json({ message: 'MercadoLibre re-authorization required', code: 'ML_REAUTH_REQUIRED' })
      if (err.code === 'ML_NOT_CONNECTED') return res.status(409).json({ message: 'No active MercadoLibre connection', code: 'ML_NOT_CONNECTED' })
      return res.status(502).json({ message: err.message ?? 'Failed to close ML item' })
    }
  }

  const remoteQuery = req.scope.resolve('remoteQuery')

  // Ownership: the product must belong to this seller (defense in depth).
  const { data: sellerRows } = await remoteQuery.graph({
    entity: 'seller',
    fields: ['id', 'products.id'],
    filters: { id: seller.id },
  })
  const ownedIds = (((sellerRows?.[0] as any)?.products ?? []) as any[]).map((p) => p.id)
  if (!ownedIds.includes(product_id)) {
    return res.status(403).json({ message: 'Product not found in this shop' })
  }

  // Read the product (any status — we need a draft/archived one to close the ML item).
  const { data: products } = await remoteQuery.graph({
    entity: 'product',
    fields: [
      'id', 'title', 'description', 'status', 'metadata', 'created_at',
      'variants.*', 'variants.prices.*',
      'variants.inventory_items.inventory.location_levels.stocked_quantity',
      'variants.inventory_items.inventory.location_levels.reserved_quantity',
      'images.*', 'categories.*', 'type.*', 'tags.*',
    ],
    filters: { id: product_id },
  })
  const product = products?.[0]
  if (!product) return res.status(404).json({ message: 'Product not found' })

  const listing = toListingShape(product, seller)
  // ML price override (catalog-management S2 · 2.3) — read off the targeted
  // (or sole) variant's private metadata; `variants.*` above already fetches
  // it. Absent/null → `buildMlItemPayload` falls back to `listing.price_cents`.
  const productVariants: any[] = (product as any).variants ?? []
  const targetVariant = variant_id
    ? productVariants.find((v) => v.id === variant_id)
    : productVariants.length <= 1 ? productVariants[0] : undefined
  const mlPriceCentsRaw = (targetVariant?.metadata as Record<string, unknown> | undefined)?.ml_price_cents
  const mlPriceCents = typeof mlPriceCentsRaw === 'number' && Number.isInteger(mlPriceCentsRaw) && mlPriceCentsRaw >= 0
    ? mlPriceCentsRaw
    : null
  const input: MlPublishInput = {
    title: listing.title,
    price_cents: listing.price_cents,
    currency: listing.currency,
    description: listing.description,
    condition: listing.condition,
    available_quantity: listing.available_quantity,
    images: listing.images.map((i) => ({ url: i.url })),
    ml_price_cents: mlPriceCents,
  }

  // Per-product ML toggle (catalog-management S2 · 2.2) — absent metadata key
  // = today's behavior (true), so every product linked before this sprint
  // shipped keeps reconciling exactly as it did.
  const mlEnabled = ((product as any).metadata as Record<string, unknown> | undefined)?.ml_enabled !== false
  const entitlement = await resolveMlOrdersEntitlement(req.scope, seller.id)

  try {
    const result = await ml.publishOrSyncProduct({
      sellerId: seller.id,
      productId: product_id,
      variantId: variant_id ?? null,
      input,
      productPublished: (product as any).status === 'published',
      categoryId: category_id ?? null,
      mlEnabled,
      entitled: entitlement.entitled,
    })
    await ml.recordSyncEvent({
      sellerId: seller.id,
      kind: 'publish',
      outcome: 'ok',
      productId: product_id,
      mlItemId: result.ml_item_id,
      code: result.action,
      message: `Mercado Libre: ${result.action} (${result.status ?? 'ok'})`,
      metadata: { action: result.action, created: result.created },
    })
    return res.status(200).json(result)
  } catch (e) {
    const err = e as { code?: string; message?: string; mlCode?: string | null; mlMessage?: string | null }
    await ml.recordSyncEvent({
      sellerId: seller.id, kind: 'publish', outcome: 'fail', productId: product_id,
      code: err.code ?? err.mlCode ?? null, message: err.message,
    })
    if (err.code === 'ML_REAUTH_REQUIRED') return res.status(409).json({ message: 'MercadoLibre re-authorization required', code: 'ML_REAUTH_REQUIRED' })
    if (err.code === 'ML_NOT_CONNECTED') return res.status(409).json({ message: 'No active MercadoLibre connection', code: 'ML_NOT_CONNECTED' })
    if (err.code === 'ML_NO_CATEGORY') return res.status(422).json({ message: 'A category is required to publish', code: 'ML_NO_CATEGORY' })
    if (err.code === 'ML_INVALID_PRODUCT') return res.status(422).json({ message: 'Product needs a title and a price to publish', code: 'ML_INVALID_PRODUCT' })
    if (err.code === 'ML_LINK_CONFLICT') return res.status(409).json({ message: 'Product or ML item is already linked', code: 'ML_LINK_CONFLICT' })
    if (err.code === 'ML_NOT_ENTITLED') return res.status(402).json({ message: 'This shop does not have the Mercado Libre sync add-on enabled', code: 'ML_NOT_ENTITLED' })
    // ML's own rejection reason (e.g. a price change blocked by an active
    // promotion) — surfaced honestly rather than a generic failure (US-5).
    return res.status(502).json({
      message: err.mlMessage ?? err.message ?? 'Failed to publish to Mercado Libre',
      code: err.mlCode ?? null,
    })
  }
}
