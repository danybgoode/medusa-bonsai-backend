import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { resolveSeller } from '../../../../_utils/clerk-auth'
import { updateSellerProduct, type SellerProductUpdateBody } from '../../../../_utils/seller-product-update'
import { toListingShape } from '../../../../_utils/listing'
import { isEnabled } from '../../../../../../lib/flags'
import { MERCADOLIBRE_MODULE } from '../../../../../../modules/mercadolibre'
import type MercadolibreModuleService from '../../../../../../modules/mercadolibre/service'
import type { MlPublishInput } from '../../../../../../modules/mercadolibre/_utils'

/**
 * POST /store/sellers/me/profit/apply-price — one-click Apply (Sprint 2 ·
 * US-5): writes the Miyagi variant price via the SAME shared write path
 * `PATCH /store/sellers/me/products/:id` uses (`updateSellerProduct`, called
 * directly — no self-HTTP round-trip), then — only if the product has a
 * linked ML item AND `ml.publish_enabled` is on — pushes the new price to
 * ML via the existing publish/update parity (`publishOrSyncProduct`, called
 * directly for the same reason). Every attempt is logged to the `ml_sync_event`
 * activity log as `price_apply`. The Miyagi write is never rolled back on an
 * ML failure — the response reports both outcomes honestly.
 *
 * body: { product_id, variant_id, new_price_cents, target_margin_pct }
 * Gate order: flag → auth (LEARNINGS — same as the rest of the epic).
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!(await isEnabled('ops.profit_enabled'))) {
    return res.status(404).json({ message: 'Not found' })
  }

  const sellerAuth = await resolveSeller(req)
  if (!sellerAuth) return res.status(401).json({ message: 'Unauthorized' })

  const { product_id, variant_id, new_price_cents, target_margin_pct } = (req.body ?? {}) as {
    product_id?: string
    variant_id?: string
    new_price_cents?: number
    target_margin_pct?: number
  }
  if (!product_id || !variant_id || !Number.isInteger(new_price_cents) || (new_price_cents as number) <= 0) {
    return res.status(422).json({ message: 'product_id, variant_id and a positive integer new_price_cents are required' })
  }

  const remoteQuery = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const ml = req.scope.resolve(MERCADOLIBRE_MODULE) as MercadolibreModuleService

  // Ownership (defense in depth — mirrors /store/sellers/me/products/:id).
  const { data: sellerRows } = await remoteQuery.graph({
    entity: 'seller',
    fields: ['id', 'products.id'],
    filters: { id: sellerAuth.sellerId },
  })
  const ownedIds = (((sellerRows?.[0] as any)?.products ?? []) as any[]).map((p) => p.id)
  if (!ownedIds.includes(product_id)) {
    return res.status(403).json({ message: 'Product not found in this shop' })
  }

  // Read the current price BEFORE the write, for the activity-log's old/new
  // pair — best-effort (a read failure just omits old_price_cents, never
  // blocks the write itself).
  let oldPriceCents: number | null = null
  try {
    const { data: rows } = await remoteQuery.graph({
      entity: 'product',
      fields: ['id', 'variants.id', 'variants.prices.amount', 'variants.prices.currency_code'],
      filters: { id: product_id },
    })
    const variant = (((rows?.[0] as any)?.variants ?? []) as any[]).find((v) => v.id === variant_id)
    const mxnPrice = ((variant?.prices ?? []) as any[]).find((p) => p.currency_code === 'mxn')
    if (mxnPrice && typeof mxnPrice.amount === 'number') oldPriceCents = mxnPrice.amount
  } catch {
    // best-effort — proceed without the old price
  }

  const miyagiBody: SellerProductUpdateBody = { variant_id, price_cents: new_price_cents as number }
  const miyagiResult = await updateSellerProduct(req.scope, product_id, miyagiBody)

  if (!miyagiResult.ok) {
    await ml.recordSyncEvent({
      sellerId: sellerAuth.sellerId, kind: 'price_apply', outcome: 'fail', productId: product_id,
      code: 'MIYAGI_WRITE_FAILED', message: miyagiResult.message,
      metadata: { variant_id, old_price_cents: oldPriceCents, new_price_cents, target_margin_pct: target_margin_pct ?? null },
    })
    return res.status(miyagiResult.status).json({ miyagi: 'failed', message: miyagiResult.message })
  }

  // ── ML push — only if linked AND the publish rail is enabled ────────────────
  const link = await ml.getLinkByProduct(product_id)
  if (!link || link.seller_id !== sellerAuth.sellerId || !(await isEnabled('ml.publish_enabled'))) {
    await ml.recordSyncEvent({
      sellerId: sellerAuth.sellerId, kind: 'price_apply', outcome: 'ok', productId: product_id,
      code: 'ml_skipped',
      message: 'Precio de Miyagi actualizado (sin publicación en Mercado Libre — sin vínculo o publicación desactivada)',
      metadata: { variant_id, old_price_cents: oldPriceCents, new_price_cents, target_margin_pct: target_margin_pct ?? null },
    })
    return res.json({ miyagi: 'ok', ml: 'skipped' })
  }

  try {
    const { data: products } = await remoteQuery.graph({
      entity: 'product',
      fields: [
        'id', 'title', 'description', 'status', 'metadata',
        'variants.*', 'variants.prices.*',
        'variants.inventory_items.inventory.location_levels.stocked_quantity',
        'variants.inventory_items.inventory.location_levels.reserved_quantity',
        'images.*', 'categories.*', 'type.*', 'tags.*',
      ],
      filters: { id: product_id },
    })
    const product = products?.[0]
    if (!product) throw new Error('Product not found after Miyagi price write')

    const seller = { id: sellerAuth.sellerId, name: sellerAuth.sellerName } as any
    const listing = toListingShape(product, seller)
    const input: MlPublishInput = {
      title: listing.title,
      price_cents: listing.price_cents,
      currency: listing.currency,
      description: listing.description,
      condition: listing.condition,
      available_quantity: listing.available_quantity,
      images: listing.images.map((i) => ({ url: i.url })),
    }

    const result = await ml.publishOrSyncProduct({
      sellerId: sellerAuth.sellerId,
      productId: product_id,
      variantId: variant_id,
      input,
      productPublished: (product as any).status === 'published',
      categoryId: null, // reconcile reuses the link's stored ml_category_id
    })

    await ml.recordSyncEvent({
      sellerId: sellerAuth.sellerId, kind: 'price_apply', outcome: 'ok', productId: product_id,
      mlItemId: result.ml_item_id, code: result.action,
      message: `Precio aplicado — Mercado Libre: ${result.action} (${result.status ?? 'ok'})`,
      metadata: { variant_id, old_price_cents: oldPriceCents, new_price_cents, target_margin_pct: target_margin_pct ?? null },
    })
    return res.json({ miyagi: 'ok', ml: 'ok', action: result.action, permalink: result.permalink })
  } catch (e) {
    const err = e as { code?: string; message?: string; mlCode?: string | null; mlMessage?: string | null }
    const reason = err.mlMessage ?? err.message ?? 'Failed to update Mercado Libre'
    await ml.recordSyncEvent({
      sellerId: sellerAuth.sellerId, kind: 'price_apply', outcome: 'fail', productId: product_id,
      code: err.code ?? err.mlCode ?? null, message: reason,
      metadata: { variant_id, old_price_cents: oldPriceCents, new_price_cents, target_margin_pct: target_margin_pct ?? null },
    })
    // Miyagi already succeeded — 200 with an honest partial-state body, never
    // a silent half-state and never a rollback of the Miyagi price.
    return res.json({ miyagi: 'ok', ml: 'failed', ml_reason: reason })
  }
}
