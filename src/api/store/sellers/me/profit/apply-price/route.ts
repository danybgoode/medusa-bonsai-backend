import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { resolveSeller } from '../../../../_utils/clerk-auth'
import { isEnabled } from '../../../../../../lib/flags'
import { applySellerPrice, type ApplyPriceBody } from '../../../../_utils/profit-apply-price'

/**
 * POST /store/sellers/me/profit/apply-price — one-click Apply (Sprint 2 ·
 * US-5). The full pipeline (ownership check → Miyagi variant-price write →
 * conditional ML push → `price_apply` activity log) lives in the shared
 * `applySellerPrice` core (_utils/profit-apply-price.ts, extracted
 * mcp-parity-core S3.2) so the agent-facing internal route prices through the
 * exact same path. This route only gates the flag and authenticates the
 * seller, then serializes the outcome verbatim.
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

  const outcome = await applySellerPrice(
    req.scope,
    { sellerId: sellerAuth.sellerId, sellerName: sellerAuth.sellerName },
    (req.body ?? {}) as ApplyPriceBody,
  )
  return res.status(outcome.httpStatus).json(outcome.body)
}
