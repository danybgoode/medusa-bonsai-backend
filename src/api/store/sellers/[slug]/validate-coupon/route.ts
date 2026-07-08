/**
 * GET /store/sellers/:slug/validate-coupon?code=...&items_cents=...
 *
 * Real-time coupon preview for checkout: given a seller + an item subtotal,
 * returns whether a code is valid and the discount it would apply. The
 * authoritative re-check happens at start-checkout — this endpoint is only so
 * the buyer sees the discount before paying.
 *
 * `:slug` may be a seller slug OR a seller id (resolved either way), matching
 * the checkout-options route.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { IPromotionModuleService } from '@medusajs/framework/types'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'
import { resolveCouponForCheckout, couponErrorMessage } from '../../../_utils/coupons'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const { slug } = req.params

  let [seller] = await sellerService.listSellers({ slug } as never, { take: 1 })
  if (!seller) {
    const [byId] = await sellerService.listSellers({ id: slug } as never, { take: 1 })
    seller = byId
  }
  if (!seller) {
    return res.status(404).json({ valid: false, message: `Seller '${slug}' not found` })
  }

  const code = (req.query.code as string) || ''
  const itemsCents = Math.max(0, Math.round(Number(req.query.items_cents ?? 0)))
  if (!code.trim()) {
    return res.status(400).json({ valid: false, message: 'Escribe un código.' })
  }

  const meta = (seller.metadata ?? {}) as Record<string, unknown>
  const couponIds = Array.isArray(meta.coupon_ids) ? (meta.coupon_ids as string[]) : []

  // Optional cart product ids (comma-separated) so a PRODUCT-SCOPED coupon is
  // previewed honestly — present ⇒ its discount; absent ⇒ foreign_product. The
  // authoritative per-product-subtotal check still runs at start-checkout; here
  // the whole item subtotal is the best-effort base for the scoped preview.
  const productIds = ((req.query.product_ids as string) || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  const cartScope = productIds.length
    ? { productIds, productSubtotals: Object.fromEntries(productIds.map((id) => [id, itemsCents])) }
    : undefined

  const promotionService = req.scope.resolve(Modules.PROMOTION) as IPromotionModuleService
  const resolution = await resolveCouponForCheckout(promotionService, code, couponIds, itemsCents, cartScope)

  if (!resolution.ok) {
    return res.json({ valid: false, reason: resolution.reason, message: couponErrorMessage(resolution.reason) })
  }
  return res.json({
    valid: true,
    code: resolution.code,
    discount_cents: resolution.discount_cents,
  })
}
