/**
 * Internal service route — create/list products on behalf of the seller's MCP agent
 * (Seller Agent Operations · Sprint 3; the GET below is owned-shop-operating-channel
 * epic S3.3). The agent has no Clerk JWT, so the Next.js frontend (which holds the
 * shared secret and has already resolved + validated the agent token → shop) calls
 * this with the shop slug.
 *
 *   POST /internal/seller-products   body: { seller_slug, title, category?, price_cents?,
 *           currency?, condition?, listing_type?, state?, municipio?, location?, quantity?,
 *           weight_grams?, status?, images?, attrs?, metadata? }
 *
 *   GET  /internal/seller-products?seller_slug=…   → { seller_slug, listings: [...] }
 *        SURFACE PARITY (AGENTS rule 3) with `GET /store/sellers/me/products`: same
 *        `querySellerCatalog` call, same `deriveChannelMembership` fields
 *        (`in_operating_channel` / `in_marketplace_channel` as SEPARATE facts, S3.3),
 *        so the seller-agent's answer to "is this buyable / published" can never drift
 *        from what the seller portal shows for the same product. Read-only — no
 *        seller-private cost data (`unit_cost_cents`), matching the store LIST route's
 *        own scope; that stays behind the seller-scoped single-item GET.
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET (same as the sibling
 * PATCH /internal/seller-products/:id route). The seller is resolved by slug and
 * the shared createSellerProduct/querySellerCatalog logic (used by the Clerk-authed
 * store routes too) runs against that seller — the agent can only ever see or change
 * the ONE shop its token was already resolved to by the frontend.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'
import { createSellerProduct, type CreateProductBody } from '../../store/_utils/seller-product-create'
import { querySellerCatalog } from '../../store/_utils/seller-catalog-query'
import { deriveChannelMembership } from '../../store/_utils/market-read'
import { resolveChannelIdsForMarket } from '../../../lib/market-medusa'
import { readSellerOperatingMarket } from '../../../lib/seller-market'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const body = req.body as CreateProductBody & { seller_slug?: string }
  const slug = body.seller_slug
  if (!slug) return res.status(400).json({ message: 'seller_slug required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const result = await createSellerProduct(req.scope, seller.id, body)
  if (!result.ok) return res.status(result.status).json({ message: result.message })

  res.status(201).json({ product_id: result.product_id, seller_slug: seller.slug })
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const slug = typeof req.query?.seller_slug === 'string' ? req.query.seller_slug : undefined
  if (!slug) return res.status(400).json({ message: 'seller_slug required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const { pairs, mlLinkedIds } = await querySellerCatalog(req.scope, seller, { sort: 'recent' })

  // Same degrade-not-crash rule as the store list route: an unclassifiable seller's
  // market still returns their products, just with both membership facts `false`
  // rather than a 422 that would make the agent's read fail outright.
  const sellerMarketRead = readSellerOperatingMarket(seller)
  const channelIds = sellerMarketRead.market
    ? resolveChannelIdsForMarket(sellerMarketRead.market, process.env)
    : { operating_channel_id: null, marketplace_channel_id: null }

  res.json({
    seller_slug: seller.slug,
    listings: pairs.map((p) => ({
      ...p.listing,
      channels: mlLinkedIds.has(p.listing.id) ? ['miyagi', 'ml'] : ['miyagi'],
      ...deriveChannelMembership(p.raw, channelIds.operating_channel_id, channelIds.marketplace_channel_id),
    })),
  })
}
