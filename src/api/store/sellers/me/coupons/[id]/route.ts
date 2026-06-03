/**
 * PATCH  /store/sellers/me/coupons/:id — update a coupon (toggle active, value, expiry, usage_limit)
 * DELETE /store/sellers/me/coupons/:id — delete a coupon
 *
 * Ownership enforced via seller.metadata.coupon_ids.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../../modules/seller'
import SellerModuleService from '../../../../../../modules/seller/service'
import { extractClerkUserId } from '../../../../_utils/clerk-auth'
import {
  resolvePromotionService,
  updateSellerCoupon,
  deleteSellerCoupon,
} from '../../../../_utils/coupons'

function couponIdsOf(seller: { metadata?: unknown }): string[] {
  const meta = (seller.metadata ?? {}) as Record<string, unknown>
  const ids = meta.coupon_ids
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
}

async function loadOwnedSeller(req: MedusaRequest, res: MedusaResponse, couponId: string) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) {
    res.status(401).json({ message: 'Authentication required' })
    return null
  }
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (!seller) {
    res.status(404).json({ message: 'No seller profile found.' })
    return null
  }
  if (!couponIdsOf(seller).includes(couponId)) {
    res.status(404).json({ message: 'Cupón no encontrado.' })
    return null
  }
  return { sellerService, seller }
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const couponId = req.params.id
  const ctx = await loadOwnedSeller(req, res, couponId)
  if (!ctx) return

  const body = (req.body ?? {}) as {
    active?: boolean
    value?: number
    expiry?: string | null
    usage_limit?: number | null
  }

  const promo = resolvePromotionService(req.scope)
  const coupon = await updateSellerCoupon(promo, couponId, {
    active: body.active,
    value: body.value,
    expiry: body.expiry,
    usage_limit: body.usage_limit,
  })
  res.json({ coupon })
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  const couponId = req.params.id
  const ctx = await loadOwnedSeller(req, res, couponId)
  if (!ctx) return
  const { sellerService, seller } = ctx

  const promo = resolvePromotionService(req.scope)
  await deleteSellerCoupon(promo, couponId)

  const meta = (seller.metadata ?? {}) as Record<string, unknown>
  await sellerService.updateSellers({
    id: seller.id,
    metadata: { ...meta, coupon_ids: couponIdsOf(seller).filter(id => id !== couponId) },
  })

  res.json({ deleted: true })
}
