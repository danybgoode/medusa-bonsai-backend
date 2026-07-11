/**
 * POST /internal/print/placement-product
 *
 * Creates a Medusa product representing one print-ad placement TIER for an edition,
 * linked to the platform-owned seller (resolved via `PLATFORM_SELLER_SLUG`, see
 * ../../_utils/platform-seller). The placement is sold through the normal
 * cart → start-checkout → order flow exactly like any product; this route only
 * exists so the (secret-gated) Next.js admin can mint the product without a Clerk
 * seller session. It mirrors the creation logic in
 * api/store/sellers/me/products/route.ts, minus inventory (placements are digital).
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { IProductModuleService } from '@medusajs/framework/types'
import { createProductsWorkflow } from '@medusajs/medusa/core-flows'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { resolveDefaultShippingProfileId } from '../../../store/_utils/fulfillment'
import { resolvePlatformSellerSlug } from '../../_utils/platform-seller'

function generateSku(): string {
  const ts = Date.now().toString(36).toUpperCase()
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase()
  return `MIYAGI-PRINT-${ts}-${rand}`
}

interface Body {
  seller_slug?: string
  title: string
  description?: string | null
  price_cents: number
  currency?: string
  /** Echoed back into product metadata for admin correlation. */
  edition_id?: string
  tier_key?: string
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const secret = req.headers['x-internal-secret']
  if (!secret || secret !== process.env.MEDUSA_INTERNAL_SECRET) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const body = req.body as Body
  if (!body.title?.trim() || body.title.trim().length < 3) {
    return res.status(400).json({ message: 'title must be at least 3 characters' })
  }
  if (!body.price_cents || body.price_cents <= 0) {
    return res.status(400).json({ message: 'price_cents must be a positive integer' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const productService: IProductModuleService = req.scope.resolve(Modules.PRODUCT)
  const remoteLink = req.scope.resolve(ContainerRegistrationKeys.LINK)

  // ── Resolve the platform-owned seller ─────────────────────────────────────
  const slug = resolvePlatformSellerSlug(body.seller_slug)
  if (!slug) {
    return res.status(400).json({ message: 'PLATFORM_SELLER_SLUG is not configured.' })
  }
  const [seller] = await sellerService.listSellers({ slug } as any, { take: 1 })
  if (!seller) {
    return res.status(404).json({
      message: `Seller "${slug}" not found. Create the platform seller first.`,
    })
  }

  // ── Resolve sales channel (same as sellers/me/products) ───────────────────
  let salesChannelId: string | undefined = process.env.MEDUSA_SALES_CHANNEL_ID || undefined
  if (!salesChannelId) {
    try {
      const storeService: any = req.scope.resolve(Modules.STORE)
      const [store] = await storeService.listStores({}, { select: ['default_sales_channel_id'], take: 1 })
      salesChannelId = store?.default_sales_channel_id ?? undefined
    } catch (e) {
      console.error('[print/placement-product] sales channel resolve failed:', e)
    }
  }

  // ── Product type 'digital' (non-stockable → no inventory ceremony) ────────
  const [ptype] = await productService.listProductTypes({ value: 'digital' })
  const shippingProfileId = await resolveDefaultShippingProfileId(req.scope)
  const currency = (body.currency ?? 'MXN').toLowerCase()
  const sku = generateSku()

  const metadata: Record<string, unknown> = {
    listing_type: 'print_ad',
    // Excludes the placement from general browse/search (see api/store/listings).
    is_print_placement: true,
    currency: (body.currency ?? 'MXN'),
    price_cents: body.price_cents,
    ...(body.edition_id ? { print_edition_id: body.edition_id } : {}),
    ...(body.tier_key ? { print_tier_key: body.tier_key } : {}),
  }

  const { result } = await createProductsWorkflow(req.scope).run({
    input: {
      products: [{
        title: body.title.trim().slice(0, 100),
        description: body.description?.trim() || null,
        status: 'published' as const,
        ...(shippingProfileId ? { shipping_profile_id: shippingProfileId } : {}),
        ...(salesChannelId ? { sales_channels: [{ id: salesChannelId }] } : {}),
        ...(ptype ? { type_id: ptype.id } : {}),
        options: [{ title: 'Default', values: ['Default'] }],
        metadata,
        variants: [{
          title: body.title.trim().slice(0, 100),
          sku,
          options: { Default: 'Default' },
          manage_inventory: false,
          prices: [{ amount: body.price_cents, currency_code: currency }],
        }],
      }],
    },
  })
  const product = result[0]

  // ── Link product → platform-owned seller ──────────────────────────────────
  await remoteLink.create({
    [SELLER_MODULE]: { seller_id: seller.id },
    [Modules.PRODUCT]: { product_id: product.id },
  })

  res.status(201).json({
    product_id: product.id,
    seller_id: seller.id,
    seller_slug: seller.slug,
  })
}
