import { MedusaRequest } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { updateSellerProduct, type SellerProductUpdateBody } from './seller-product-update'
import { toListingShape } from './listing'
import { resolveSellerProductIds } from './seller-catalog-query'
import { isEnabled } from '../../../lib/flags'
import { MERCADOLIBRE_MODULE } from '../../../modules/mercadolibre'
import type MercadolibreModuleService from '../../../modules/mercadolibre/service'
import type { MlPublishInput } from '../../../modules/mercadolibre/_utils'

/**
 * One-click Apply core (profit-analyzer S2 · US-5) — extracted verbatim from
 * `store/sellers/me/profit/apply-price/route.ts` (mcp-parity-core S3.2) so the
 * internal service route (`/internal/profit/apply-price`, called by the
 * frontend on behalf of a shop's MCP agent, which has no Clerk JWT) prices
 * through the EXACT same pipeline as the Clerk portal path: ownership check →
 * Miyagi variant-price write via the shared `updateSellerProduct` → the
 * conditional ML push → the `price_apply` activity log. The Miyagi write is
 * never rolled back on an ML failure — the result reports both outcomes
 * honestly, and callers serialize it as-is.
 *
 * Both callers gate on `ops.profit_enabled` BEFORE invoking this (gate order:
 * flag → auth → core, per LEARNINGS).
 */

export interface ApplyPriceBody {
  product_id?: string
  variant_id?: string
  new_price_cents?: number
  target_margin_pct?: number
}

export interface ApplyPriceOutcome {
  /** HTTP status the caller should respond with. */
  httpStatus: number
  /** JSON body to send verbatim. */
  body: Record<string, unknown>
}

/**
 * Activity logging is observability, never outcome: a failed `price_apply`
 * log write must not turn an already-determined price-write result into a 500
 * (Codex cross-review catch on the S3.2 extraction — the pre-extraction route
 * had the same latent issue).
 */
async function recordSyncEventBestEffort(
  ml: MercadolibreModuleService,
  event: Parameters<MercadolibreModuleService['recordSyncEvent']>[0],
): Promise<void> {
  try {
    await ml.recordSyncEvent(event)
  } catch (e) {
    console.error('[profit-apply-price] price_apply activity-log write failed (non-fatal):', e)
  }
}

export async function applySellerPrice(
  scope: MedusaRequest['scope'],
  sellerCtx: { sellerId: string; sellerName: string | null },
  rawBody: ApplyPriceBody,
): Promise<ApplyPriceOutcome> {
  const { product_id, variant_id, new_price_cents, target_margin_pct } = rawBody ?? {}
  if (!product_id || !variant_id || !Number.isInteger(new_price_cents) || (new_price_cents as number) <= 0) {
    return { httpStatus: 422, body: { message: 'product_id, variant_id and a positive integer new_price_cents are required' } }
  }

  const remoteQuery = scope.resolve(ContainerRegistrationKeys.QUERY)
  const ml = scope.resolve(MERCADOLIBRE_MODULE) as MercadolibreModuleService

  // Ownership (defense in depth — mirrors /store/sellers/me/products/:id).
  const ownedIds = await resolveSellerProductIds(scope, sellerCtx.sellerId)
  if (!ownedIds.has(product_id)) {
    return { httpStatus: 403, body: { message: 'Product not found in this shop' } }
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
  const miyagiResult = await updateSellerProduct(scope, product_id, miyagiBody)

  if (!miyagiResult.ok) {
    await recordSyncEventBestEffort(ml, {
      sellerId: sellerCtx.sellerId, kind: 'price_apply', outcome: 'fail', productId: product_id,
      code: 'MIYAGI_WRITE_FAILED', message: miyagiResult.message,
      metadata: { variant_id, old_price_cents: oldPriceCents, new_price_cents, target_margin_pct: target_margin_pct ?? null },
    })
    return { httpStatus: miyagiResult.status, body: { miyagi: 'failed', message: miyagiResult.message } }
  }

  // ── ML push — only if linked AND the publish rail is enabled ────────────────
  const link = await ml.getLinkByProduct(product_id)
  if (!link || link.seller_id !== sellerCtx.sellerId || !(await isEnabled('ml.publish_enabled'))) {
    await recordSyncEventBestEffort(ml, {
      sellerId: sellerCtx.sellerId, kind: 'price_apply', outcome: 'ok', productId: product_id,
      code: 'ml_skipped',
      message: 'Precio de Miyagi actualizado (sin publicación en Mercado Libre — sin vínculo o publicación desactivada)',
      metadata: { variant_id, old_price_cents: oldPriceCents, new_price_cents, target_margin_pct: target_margin_pct ?? null },
    })
    return { httpStatus: 200, body: { miyagi: 'ok', ml: 'skipped' } }
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

    const seller = { id: sellerCtx.sellerId, name: sellerCtx.sellerName } as any
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
      sellerId: sellerCtx.sellerId,
      productId: product_id,
      variantId: variant_id,
      input,
      productPublished: (product as any).status === 'published',
      categoryId: null, // reconcile reuses the link's stored ml_category_id
    })

    await recordSyncEventBestEffort(ml, {
      sellerId: sellerCtx.sellerId, kind: 'price_apply', outcome: 'ok', productId: product_id,
      mlItemId: result.ml_item_id, code: result.action,
      message: `Precio aplicado — Mercado Libre: ${result.action} (${result.status ?? 'ok'})`,
      metadata: { variant_id, old_price_cents: oldPriceCents, new_price_cents, target_margin_pct: target_margin_pct ?? null },
    })
    return { httpStatus: 200, body: { miyagi: 'ok', ml: 'ok', action: result.action, permalink: result.permalink } }
  } catch (e) {
    const err = e as { code?: string; message?: string; mlCode?: string | null; mlMessage?: string | null }
    const reason = err.mlMessage ?? err.message ?? 'Failed to update Mercado Libre'
    await recordSyncEventBestEffort(ml, {
      sellerId: sellerCtx.sellerId, kind: 'price_apply', outcome: 'fail', productId: product_id,
      code: err.code ?? err.mlCode ?? null, message: reason,
      metadata: { variant_id, old_price_cents: oldPriceCents, new_price_cents, target_margin_pct: target_margin_pct ?? null },
    })
    // Miyagi already succeeded — 200 with an honest partial-state body, never
    // a silent half-state and never a rollback of the Miyagi price.
    return { httpStatus: 200, body: { miyagi: 'ok', ml: 'failed', ml_reason: reason } }
  }
}
