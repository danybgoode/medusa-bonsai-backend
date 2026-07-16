/**
 * Internal service route — apply a computed price to a seller's variant on
 * behalf of the seller's MCP agent (mcp-parity-core S3.2). The agent has no
 * Clerk JWT, so the Next.js frontend (which holds the shared secret and has
 * already resolved + ownership-checked the agent token → shop) calls this
 * with the shop slug — same service-to-service door as
 * /internal/seller-products.
 *
 *   POST /internal/profit/apply-price   body: { seller_slug, product_id,
 *           variant_id, new_price_cents, target_margin_pct? }
 *   → the same honest partial-state body as the portal route
 *     ({ miyagi: ok|failed, ml: ok|failed|skipped, ... })
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET. Gate order
 * matches the portal route exactly: ops.profit_enabled flag → auth → the
 * shared applySellerPrice core (ownership re-check, Miyagi write, conditional
 * ML push, price_apply activity log).
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { isEnabled } from '../../../../lib/flags'
import { applySellerPrice, type ApplyPriceBody } from '../../../store/_utils/profit-apply-price'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!(await isEnabled('ops.profit_enabled'))) {
    return res.status(404).json({ message: 'Not found' })
  }

  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  if (!expected || got !== expected) return res.status(401).json({ message: 'Unauthorized' })

  const body = (req.body ?? {}) as ApplyPriceBody & { seller_slug?: string }
  const slug = body.seller_slug
  if (!slug) return res.status(400).json({ message: 'seller_slug required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const outcome = await applySellerPrice(
    req.scope,
    { sellerId: seller.id, sellerName: seller.name ?? null },
    body,
  )
  return res.status(outcome.httpStatus).json(outcome.body)
}
