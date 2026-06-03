/**
 * Platform coupons — coupons owned by the platform's own shop (`miyagiprints`,
 * the print-ad seller), as opposed to a regular seller's coupons. These are the
 * funding-safe "marketplace/admin coupons": redeemable on print-ad checkout,
 * which the platform actually bills. The SAME route mints referral rewards.
 *
 *   POST   /internal/platform-coupons        — create a platform coupon
 *   GET    /internal/platform-coupons        — list platform coupons (+usage)
 *   DELETE /internal/platform-coupons?id=...  — delete one
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET (same as the
 * other /internal routes). Callers: the admin coupons UI proxy and the referral
 * reward issuer (both server-side, holding the shared secret).
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'
import {
  resolvePromotionService,
  createSellerCoupon,
  listSellerCoupons,
  deleteSellerCoupon,
  normalizeCode,
  type CouponInput,
} from '../../store/_utils/coupons'

// The platform's own shop that bills print-ad placements.
const PLATFORM_SELLER_SLUG = 'miyagiprints'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !!expected && got !== expected
}

function couponIdsOf(seller: { metadata?: unknown }): string[] {
  const meta = (seller.metadata ?? {}) as Record<string, unknown>
  const ids = meta.coupon_ids
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
}

async function resolvePlatformSeller(req: MedusaRequest) {
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const slug = ((req.body as { seller_slug?: string })?.seller_slug)
    || (req.query.seller_slug as string)
    || PLATFORM_SELLER_SLUG
  const [seller] = await sellerService.listSellers({ slug } as never, { take: 1 })
  return { sellerService, seller }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })
  const { seller } = await resolvePlatformSeller(req)
  if (!seller) return res.status(404).json({ message: 'Platform seller not found.' })

  const promo = resolvePromotionService(req.scope)
  const coupons = await listSellerCoupons(promo, couponIdsOf(seller))
  res.json({ coupons })
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })
  const { sellerService, seller } = await resolvePlatformSeller(req)
  if (!seller) return res.status(404).json({ message: 'Platform seller not found.' })

  const body = (req.body ?? {}) as Partial<CouponInput> & { created_by?: string }
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
  const mine = await listSellerCoupons(promo, existingIds)
  if (mine.some(c => c.code === code)) {
    return res.status(409).json({ message: 'Ya existe un cupón con este código.' })
  }

  let coupon
  try {
    coupon = await createSellerCoupon(
      promo,
      { code, type: body.type, value, expiry: body.expiry ?? null, usage_limit: body.usage_limit ?? null },
      seller.id,
      body.created_by ?? 'platform',
    )
  } catch (e: unknown) {
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

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })
  const { sellerService, seller } = await resolvePlatformSeller(req)
  if (!seller) return res.status(404).json({ message: 'Platform seller not found.' })

  const couponId = (req.query.id as string) || ''
  if (!couponId) return res.status(400).json({ message: 'id requerido.' })
  if (!couponIdsOf(seller).includes(couponId)) {
    return res.status(404).json({ message: 'Cupón no encontrado.' })
  }

  const promo = resolvePromotionService(req.scope)
  await deleteSellerCoupon(promo, couponId)

  const meta = (seller.metadata ?? {}) as Record<string, unknown>
  await sellerService.updateSellers({
    id: seller.id,
    metadata: { ...meta, coupon_ids: couponIdsOf(seller).filter(id => id !== couponId) },
  })

  res.json({ deleted: true })
}
