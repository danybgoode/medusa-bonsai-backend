/**
 * Seller coupon codes — built on Medusa's Promotion module (a default v2 module,
 * resolvable via Modules.PROMOTION). The Promotion module is the system-of-record
 * for the code, discount, expiry (campaign.ends_at) and usage limit / depletion
 * (campaign.budget, type 'usage').
 *
 * IMPORTANT — checkout does not run carts through Medusa's pricing engine. The
 * start-checkout route bills Stripe/MP with a manually-computed `priceCents`
 * (see carts/[id]/start-checkout). So we use the Promotion module for storage +
 * lifecycle + usage accounting, but compute the discount amount ourselves here
 * (computeCouponDiscountCents) and fold it into priceCents — the same seam the
 * bundle discount already uses.
 *
 * Seller scoping: a seller owns a coupon iff its promotion id is listed in
 * `seller.metadata.coupon_ids` (maintained by the coupon routes), mirroring how
 * `bundles`/`offers` already live in seller metadata. We never honor a code at
 * checkout whose promotion id isn't in the resolved seller's index.
 */

import { Modules } from '@medusajs/framework/utils'
import { IPromotionModuleService } from '@medusajs/framework/types'

export type CouponDiscountType = 'percentage' | 'fixed'

/** Input from the seller backoffice (storefront proxies this shape through). */
export interface CouponInput {
  /** Buyer-entered code. Normalized to upper-case, no spaces. */
  code: string
  type: CouponDiscountType
  /** percent (e.g. 15) for 'percentage'; MXN major units (e.g. 100) for 'fixed'. */
  value: number
  /** ISO date string; null/undefined = no expiry. */
  expiry?: string | null
  /** Max total redemptions; null/undefined = unlimited. */
  usage_limit?: number | null
}

/** Shape returned to the backoffice UI. */
export interface CouponView {
  id: string
  code: string
  type: CouponDiscountType
  value: number
  active: boolean
  expiry: string | null
  usage_limit: number | null
  uses: number
}

export function resolvePromotionService(scope: { resolve: (k: string) => unknown }): IPromotionModuleService {
  return scope.resolve(Modules.PROMOTION) as IPromotionModuleService
}

export function normalizeCode(raw: string): string {
  return (raw ?? '').trim().toUpperCase().replace(/\s+/g, '')
}

/** percent → base*pct/100; fixed → MXN major units → cents. Never exceeds base. */
export function computeCouponDiscountCents(type: CouponDiscountType, value: number, baseCents: number): number {
  if (!Number.isFinite(value) || value <= 0 || baseCents <= 0) return 0
  const raw = type === 'percentage'
    ? Math.round((baseCents * value) / 100)
    : Math.round(value * 100)
  return Math.max(0, Math.min(raw, baseCents))
}

const RELATIONS = ['application_method', 'campaign', 'campaign.budget']

type RawPromotion = {
  id: string
  code: string
  status?: string
  application_method?: { type?: string; value?: number } | null
  campaign?: { ends_at?: string | Date | null; budget?: { type?: string; limit?: number | null; used?: number | null } | null } | null
}

function toView(p: RawPromotion): CouponView {
  const am = p.application_method ?? {}
  const budget = p.campaign?.budget ?? null
  const endsAt = p.campaign?.ends_at ?? null
  return {
    id: p.id,
    code: p.code,
    type: am.type === 'percentage' ? 'percentage' : 'fixed',
    value: Number(am.value ?? 0),
    active: p.status === 'active',
    expiry: endsAt ? new Date(endsAt).toISOString() : null,
    usage_limit: budget?.limit ?? null,
    uses: Number(budget?.used ?? 0),
  }
}

/**
 * Create a coupon = 1 Promotion + 1 per-coupon Campaign (carries the usage
 * budget + expiry). Returns the new promotion id; the caller is responsible for
 * appending it to seller.metadata.coupon_ids.
 */
export async function createSellerCoupon(
  promo: IPromotionModuleService,
  input: CouponInput,
  sellerId: string,
  clerkUserId: string,
): Promise<CouponView> {
  const code = normalizeCode(input.code)
  const campaignIdentifier = `cpn:${sellerId}:${code}:${Date.now().toString(36)}`

  const created = await promo.createPromotions([{
    code,
    type: 'standard',
    status: 'active',
    application_method: {
      type: input.type,
      target_type: 'order',
      allocation: 'across',
      value: input.value,
      currency_code: 'mxn',
    },
    campaign: {
      name: `Cupón ${code}`,
      campaign_identifier: campaignIdentifier,
      starts_at: new Date(),
      ends_at: input.expiry ? new Date(input.expiry) : undefined,
      ...(input.usage_limit != null
        ? { budget: { type: 'usage' as const, limit: input.usage_limit } }
        : {}),
    },
    // metadata is supported by the promotion model even though the create DTO
    // omits it — stamp ownership/traceability (we don't depend on it for scoping).
    metadata: { seller_id: sellerId, created_by_clerk_user_id: clerkUserId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any])

  const id = (Array.isArray(created) ? created[0]?.id : (created as { id: string }).id)
  const [full] = await promo.listPromotions({ id: [id] }, { relations: RELATIONS })
  return toView(full as unknown as RawPromotion)
}

/** List a seller's coupons (with live usage) from their id index. */
export async function listSellerCoupons(
  promo: IPromotionModuleService,
  couponIds: string[],
): Promise<CouponView[]> {
  if (!couponIds.length) return []
  const promos = await promo.listPromotions({ id: couponIds }, { relations: RELATIONS })
  return (promos as unknown as RawPromotion[]).map(toView)
}

/** Patch status (active toggle), value, expiry, or usage limit. */
export async function updateSellerCoupon(
  promo: IPromotionModuleService,
  id: string,
  patch: { active?: boolean; value?: number; expiry?: string | null; usage_limit?: number | null },
): Promise<CouponView> {
  const update: Record<string, unknown> = { id }
  if (patch.active != null) update.status = patch.active ? 'active' : 'inactive'
  if (patch.value != null) update.application_method = { value: patch.value }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await promo.updatePromotions([update as any])

  // Expiry / usage limit live on the campaign budget — update it separately.
  if (patch.expiry !== undefined || patch.usage_limit !== undefined) {
    const [current] = await promo.listPromotions({ id: [id] }, { relations: RELATIONS })
    const campaignId = (current as unknown as { campaign?: { id?: string } })?.campaign?.id
    if (campaignId) {
      await promo.updateCampaigns([{
        id: campaignId,
        ...(patch.expiry !== undefined ? { ends_at: patch.expiry ? new Date(patch.expiry) : null } : {}),
        ...(patch.usage_limit !== undefined
          ? { budget: { type: 'usage' as const, limit: patch.usage_limit } }
          : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any])
    }
  }

  const [full] = await promo.listPromotions({ id: [id] }, { relations: RELATIONS })
  return toView(full as unknown as RawPromotion)
}

export async function deleteSellerCoupon(promo: IPromotionModuleService, id: string): Promise<void> {
  await promo.deletePromotions([id])
}

export type CouponResolution =
  | { ok: true; promotion_id: string; code: string; discount_cents: number }
  | { ok: false; reason: 'not_found' | 'foreign_seller' | 'inactive' | 'expired' | 'depleted' }

/**
 * Validate a code for a specific seller + item subtotal and compute the discount.
 * Used by the real-time validate endpoint and (authoritatively) at start-checkout.
 * `allowedIds` = the resolved seller's metadata.coupon_ids.
 */
export async function resolveCouponForCheckout(
  promo: IPromotionModuleService,
  code: string,
  allowedIds: string[],
  baseCents: number,
): Promise<CouponResolution> {
  const normalized = normalizeCode(code)
  const [match] = await promo.listPromotions({ code: [normalized] }, { relations: RELATIONS })
  if (!match) return { ok: false, reason: 'not_found' }
  const p = match as unknown as RawPromotion
  if (!allowedIds.includes(p.id)) return { ok: false, reason: 'foreign_seller' }
  if (p.status !== 'active') return { ok: false, reason: 'inactive' }

  const endsAt = p.campaign?.ends_at ? new Date(p.campaign.ends_at) : null
  if (endsAt && endsAt.getTime() < Date.now()) return { ok: false, reason: 'expired' }

  const budget = p.campaign?.budget
  if (budget?.type === 'usage' && budget.limit != null && Number(budget.used ?? 0) >= budget.limit) {
    return { ok: false, reason: 'depleted' }
  }

  const type: CouponDiscountType = p.application_method?.type === 'percentage' ? 'percentage' : 'fixed'
  const discount = computeCouponDiscountCents(type, Number(p.application_method?.value ?? 0), baseCents)
  return { ok: true, promotion_id: p.id, code: normalized, discount_cents: discount }
}

/** es-MX buyer-facing message for a failed resolution. */
export function couponErrorMessage(reason: Exclude<CouponResolution, { ok: true }>['reason']): string {
  switch (reason) {
    case 'expired': return 'Este cupón ya expiró.'
    case 'depleted': return 'Este cupón alcanzó su límite de usos.'
    case 'inactive': return 'Este cupón no está disponible.'
    case 'foreign_seller': return 'Este cupón no aplica a esta tienda.'
    default: return 'Cupón no válido.'
  }
}
