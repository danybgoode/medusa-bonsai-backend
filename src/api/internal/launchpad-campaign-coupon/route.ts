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
  findSellerCouponByCode,
  normalizeCode,
} from '../../store/_utils/coupons'

// Fail CLOSED: a coupon-minting route must never be callable when the shared
// secret is unset (a misconfigured env is treated as unauthorized, not open).
function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

function couponIdsOf(seller: { metadata?: unknown }): string[] {
  const meta = (seller.metadata ?? {}) as Record<string, unknown>
  const ids = meta.coupon_ids
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
}

/**
 * Append a coupon id to a seller's `coupon_ids` index, re-reading the seller
 * FIRST so a concurrent mint for the same seller can't clobber the other's ids
 * (narrows the read-modify-write race). Idempotent — a no-op if already present.
 */
async function appendCouponId(
  sellerService: SellerModuleService,
  sellerId: string,
  couponId: string,
): Promise<void> {
  const [fresh] = await sellerService.listSellers({ id: sellerId } as never, { take: 1 })
  if (!fresh) return
  const ids = couponIdsOf(fresh)
  if (ids.includes(couponId)) return
  const meta = (fresh.metadata ?? {}) as Record<string, unknown>
  await sellerService.updateSellers({ id: sellerId, metadata: { ...meta, coupon_ids: [...ids, couponId] } })
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

  // Idempotent by CODE (globally unique), not just via the seller's id index —
  // so a prior PARTIAL mint (promotion created but never appended to coupon_ids,
  // e.g. an updateSellers failure) is repaired on replay instead of stranding the
  // campaign behind a permanent 409.
  const existing = await findSellerCouponByCode(promo, code)
  if (existing) {
    if (existing.ownerSellerId && existing.ownerSellerId !== seller.id) {
      // Someone else already owns this globally-unique code — a real conflict.
      return res.status(409).json({ message: 'Este código ya está en uso.' })
    }
    await appendCouponId(sellerService, seller.id, existing.view.id) // repair index if missing
    return res.status(200).json({ coupon: existing.view, created: false })
  }

  let coupon
  try {
    coupon = await createSellerCoupon(
      promo,
      { code, type: 'percentage', value: percent, expiry: body.expiry ?? null, usage_limit: null, scoped_product_id: productId },
      seller.id,
      'launchpad',
    )
  } catch (e: unknown) {
    // Lost a create race on the globally-unique code — re-resolve by code and
    // return it (repairing the index) if it's ours, else surface the conflict.
    const msg = e instanceof Error ? e.message : ''
    if (/unique|already exists|duplicate/i.test(msg)) {
      const raced = await findSellerCouponByCode(promo, code)
      if (raced && (!raced.ownerSellerId || raced.ownerSellerId === seller.id)) {
        await appendCouponId(sellerService, seller.id, raced.view.id)
        return res.status(200).json({ coupon: raced.view, created: false })
      }
      return res.status(409).json({ message: 'Este código ya está en uso.' })
    }
    throw e
  }

  // Re-read-before-append so a concurrent mint for the same seller can't clobber
  // this coupon id out of the index.
  await appendCouponId(sellerService, seller.id, coupon.id)

  res.status(201).json({ coupon, created: true })
}
