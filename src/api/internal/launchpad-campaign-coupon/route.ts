/**
 * POST /internal/launchpad-campaign-coupon — mint the PRODUCT-SCOPED reward coupon
 * for a bookshop-launchpad voting campaign that hit its threshold (S3.3).
 *
 * Unlike /internal/platform-coupons (the platform's own shop), this mints a
 * coupon owned by the CAMPAIGN's seller and scoped to ONE print product, so it
 * only ever discounts that book's print listing — never shop-wide. Called by the
 * frontend threshold/close automation (server-side, holds MEDUSA_INTERNAL_SECRET);
 * the seller has no Clerk session in that path, so this bypasses /sellers/me.
 *
 * Idempotent (find-or-create by code within the seller): a webhook/cron replay
 * returns the same coupon instead of minting a duplicate.
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET (same as the other
 * /internal routes).
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'
import {
  resolvePromotionService,
  createSellerCoupon,
  listSellerCoupons,
  normalizeCode,
} from '../../store/_utils/coupons'

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

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const body = (req.body ?? {}) as {
    seller_id?: string
    code?: string
    percent?: number
    product_id?: string
    expiry?: string | null
  }

  const code = normalizeCode(body.code ?? '')
  const percent = Math.round(Number(body.percent))
  const productId = (body.product_id ?? '').trim()

  if (!body.seller_id || !code || !productId) {
    return res.status(400).json({ message: 'seller_id, code y product_id son obligatorios.' })
  }
  if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
    return res.status(400).json({ message: 'El porcentaje debe estar entre 1 y 100.' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ id: body.seller_id } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Vendedor no encontrado.' })

  const promo = resolvePromotionService(req.scope)
  const existingIds = couponIdsOf(seller)

  // Idempotent: a replay returns the already-minted coupon, never a duplicate.
  const mine = await listSellerCoupons(promo, existingIds)
  const already = mine.find((c) => c.code === code)
  if (already) return res.status(200).json({ coupon: already, created: false })

  let coupon
  try {
    coupon = await createSellerCoupon(
      promo,
      { code, type: 'percentage', value: percent, expiry: body.expiry ?? null, usage_limit: null, scoped_product_id: productId },
      seller.id,
      'launchpad',
    )
  } catch (e: unknown) {
    // Globally-unique code already exists (a prior partial mint). Re-read the
    // seller's coupons and return it if present, else surface the conflict.
    const msg = e instanceof Error ? e.message : ''
    if (/unique|already exists|duplicate/i.test(msg)) {
      const retry = (await listSellerCoupons(promo, couponIdsOf(seller))).find((c) => c.code === code)
      if (retry) return res.status(200).json({ coupon: retry, created: false })
      return res.status(409).json({ message: 'Este código ya está en uso.' })
    }
    throw e
  }

  const meta = (seller.metadata ?? {}) as Record<string, unknown>
  await sellerService.updateSellers({
    id: seller.id,
    metadata: { ...meta, coupon_ids: [...existingIds, coupon.id] },
  })

  res.status(201).json({ coupon, created: true })
}
