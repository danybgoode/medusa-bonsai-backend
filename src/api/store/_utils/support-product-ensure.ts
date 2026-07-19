import { MedusaRequest } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'
import { createSellerProduct } from './seller-product-create'
import { resolveSellerProductMetadataRecords } from './seller-catalog-query'
import { isSupportProductMetadata, SUPPORT_PRODUCT_METADATA } from './support'

/**
 * Idempotent "ensure this seller has a support product" core — extracted from
 * `store/sellers/me/support-product/route.ts` (mcp-parity-core S4) so the
 * internal service route (`/internal/support-product`, called by the frontend
 * on behalf of a shop's MCP agent, which has no Clerk JWT) provisions through
 * the EXACT same reuse-first logic as the Clerk-authenticated portal path.
 * Reuses an already-linked support product when one exists (configured id
 * first, then any linked product carrying the support metadata), else creates
 * one; either way the seller's `settings.support.support_product_id` is
 * re-stamped so config and catalog can't drift apart.
 */

export interface SellerLike {
  id: string
  slug: string | null
  name: string | null
  metadata: Record<string, unknown> | null
}

async function findLinkedSupportProduct(
  scope: MedusaRequest['scope'],
  sellerId: string,
  configuredProductId?: string | null,
) {
  const remoteQuery = scope.resolve('remoteQuery')

  try {
    // One typed, null-filtered link read covers both reuse paths. The old
    // implementation queried the same seller relation twice when the
    // configured id was stale.
    const products = await resolveSellerProductMetadataRecords(remoteQuery, sellerId)
    if (configuredProductId) {
      const configured = products.find((product) => product.id === configuredProductId)
      if (configured && isSupportProductMetadata(configured.metadata)) {
        return configured.id
      }
    }
    return products.find((product) => isSupportProductMetadata(product.metadata))?.id ?? null
  } catch {
    return null
  }
}

export type EnsureSupportProductResult =
  | { ok: true; product_id: string; reused: boolean }
  | { ok: false; status: number; message: string }

export async function ensureSupportProductForSeller(
  scope: MedusaRequest['scope'],
  seller: SellerLike,
): Promise<EnsureSupportProductResult> {
  const sellerService: SellerModuleService = scope.resolve(SELLER_MODULE)

  const sellerMeta = (seller.metadata ?? {}) as Record<string, unknown>
  const settings = (sellerMeta.settings ?? {}) as Record<string, unknown>
  const supportSettings = (settings.support ?? {}) as Record<string, unknown>
  const configuredProductId = typeof supportSettings.support_product_id === 'string'
    ? supportSettings.support_product_id
    : null

  const existingProductId = await findLinkedSupportProduct(scope, seller.id, configuredProductId)
  if (existingProductId) {
    const nextSettings = {
      ...settings,
      support: {
        ...supportSettings,
        support_product_id: existingProductId,
      },
    }
    await sellerService.updateSellers({
      id: seller.id,
      metadata: { ...sellerMeta, settings: nextSettings },
    })
    return { ok: true, product_id: existingProductId, reused: true }
  }

  const result = await createSellerProduct(scope, seller.id, {
    title: `Apoyo para ${seller.name}`,
    description: `Contribuciones de apoyo para ${seller.name}.`,
    price_cents: 100,
    currency: 'MXN',
    listing_type: 'support',
    status: 'published',
    metadata: {
      ...SUPPORT_PRODUCT_METADATA,
      support_seller_id: seller.id,
      support_seller_slug: seller.slug,
    },
  })

  if (!result.ok) {
    return { ok: false, status: result.status, message: result.message }
  }

  const nextSettings = {
    ...settings,
    support: {
      ...supportSettings,
      support_product_id: result.product_id,
    },
  }
  await sellerService.updateSellers({
    id: seller.id,
    metadata: { ...sellerMeta, settings: nextSettings },
  })

  return { ok: true, product_id: result.product_id, reused: false }
}
