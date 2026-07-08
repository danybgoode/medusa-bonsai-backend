/**
 * GET  /store/sellers/me/coupons — list the current seller's coupon codes (+usage)
 * POST /store/sellers/me/coupons — create a coupon code
 *
 * Coupons are Medusa Promotions (see _utils/coupons). Ownership is tracked via
 * `seller.metadata.coupon_ids`, maintained here.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'
import { extractClerkUserId } from '../../../_utils/clerk-auth'
import {
  resolvePromotionService,
  createSellerCoupon,
  listSellerCoupons,
  normalizeCode,
  type CouponInput,
} from '../../../_utils/coupons'

function couponIdsOf(seller: { metadata?: unknown }): string[] {
  const meta = (seller.metadata ?? {}) as Record<string, unknown>
  const ids = meta.coupon_ids
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return res.status(401).json({ message: 'Authentication required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (!seller) return res.status(404).json({ message: 'No seller profile found.' })

  const promo = resolvePromotionService(req.scope)
  const coupons = await listSellerCoupons(promo, couponIdsOf(seller))
  res.json({ coupons })
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return res.status(401).json({ message: 'Authentication required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (!seller) return res.status(404).json({ message: 'No seller profile found.' })

  const body = (req.body ?? {}) as Partial<CouponInput>
  const code = normalizeCode(body.code ?? '')
  if (!code) return res.status(400).json({ message: 'El código es obligatorio.' })
  if (body.type !== 'percentage' && body.type !== 'fixed') {
    return res.status(400).json({ message: 'Tipo de descuento inválido.' })
  }
  const value = Number(body.value)
  if (!Number.isFinite(value) || value <= 0) {
    return res.status(400).json({ message: 'El monto del descuento debe ser mayor a cero.' })
  }
  if (body.type === 'percentage' && value > 100) {
    return res.status(400).json({ message: 'El porcentaje no puede ser mayor a 100.' })
  }

  const promo = resolvePromotionService(req.scope)
  const existingIds = couponIdsOf(seller)

  // Reject duplicate code within this seller's coupons
  const mine = await listSellerCoupons(promo, existingIds)
  if (mine.some(c => c.code === code)) {
    return res.status(409).json({ message: 'Ya tienes un cupón con este código.' })
  }

  let coupon
  try {
    coupon = await createSellerCoupon(
      promo,
      { code, type: body.type, value, expiry: body.expiry ?? null, usage_limit: body.usage_limit ?? null, scoped_product_id: body.scoped_product_id ?? null },
      seller.id,
      clerkUserId,
    )
  } catch (e: unknown) {
    // Promotion codes are globally unique in Medusa — surface a clean conflict
    const msg = e instanceof Error ? e.message : ''
    if (/unique|already exists|duplicate/i.test(msg)) {
      return res.status(409).json({ message: 'Este código ya está en uso. Prueba con otro.' })
    }
    throw e
  }

  const meta = (seller.metadata ?? {}) as Record<string, unknown>
  await sellerService.updateSellers({
    id: seller.id,
    metadata: { ...meta, coupon_ids: [...existingIds, coupon.id] },
  })

  res.status(201).json({ coupon })
}
