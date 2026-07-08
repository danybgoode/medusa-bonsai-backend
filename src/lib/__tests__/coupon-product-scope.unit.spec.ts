import {
  resolveCouponForCheckout,
  scopedProductIdOf,
  computeCouponDiscountCents,
} from '../../api/store/_utils/coupons'
import type { IPromotionModuleService } from '@medusajs/framework/types'

/**
 * Bookshop launchpad · Sprint 3.3 — the PRODUCT-SCOPED coupon money path.
 *
 * The 50% print unlock mints a coupon scoped (via promotion metadata) to ONE CPP
 * listing. These tests assert the load-bearing guarantees end-to-end over a mock
 * Promotion service (no DB): a scoped coupon (a) discounts ONLY the scoped
 * product's own subtotal, and (b) is REJECTED on a cart that doesn't contain the
 * product — so a different product can never accept the coupon. Non-scoped coupons
 * are unchanged (regression guard for every existing seller coupon).
 */

// A minimal mock Promotion service returning one promotion for listPromotions.
function mockPromo(promotion: Record<string, unknown> | null): IPromotionModuleService {
  return {
    listPromotions: async () => (promotion ? [promotion] : []),
  } as unknown as IPromotionModuleService
}

const activePercent = (overrides: Record<string, unknown> = {}) => ({
  id: 'promo_1',
  code: 'LIBRO50',
  status: 'active',
  application_method: { type: 'percentage', value: 50 },
  campaign: { ends_at: null, budget: null },
  ...overrides,
})

describe('scopedProductIdOf', () => {
  it('reads a product scope off metadata', () => {
    expect(scopedProductIdOf({ metadata: { scoped_product_id: 'prod_print' } })).toBe('prod_print')
  })
  it('returns null for a shop-wide coupon (no / blank scope)', () => {
    expect(scopedProductIdOf({ metadata: {} })).toBeNull()
    expect(scopedProductIdOf({ metadata: { scoped_product_id: '  ' } })).toBeNull()
    expect(scopedProductIdOf({ metadata: null })).toBeNull()
  })
})

describe('resolveCouponForCheckout — product scope', () => {
  const allowed = ['promo_1']

  it('a scoped coupon discounts ONLY the scoped product subtotal', async () => {
    const promo = mockPromo(activePercent({ metadata: { scoped_product_id: 'prod_print' } }))
    // Cart: print product 10.00 + a different product 40.00; order base 50.00.
    const resolution = await resolveCouponForCheckout(promo, 'LIBRO50', allowed, 5000, {
      productIds: ['prod_print', 'prod_other'],
      productSubtotals: { prod_print: 1000, prod_other: 4000 },
    })
    expect(resolution.ok).toBe(true)
    if (resolution.ok) {
      // 50% of the print product's 1000 (NOT 50% of the 5000 order).
      expect(resolution.discount_cents).toBe(500)
      expect(resolution.scoped_product_id).toBe('prod_print')
    }
  })

  it('rejects (foreign_product) when the cart does NOT contain the scoped product', async () => {
    const promo = mockPromo(activePercent({ metadata: { scoped_product_id: 'prod_print' } }))
    const resolution = await resolveCouponForCheckout(promo, 'LIBRO50', allowed, 4000, {
      productIds: ['prod_other'],
      productSubtotals: { prod_other: 4000 },
    })
    expect(resolution).toEqual({ ok: false, reason: 'foreign_product' })
  })

  it('rejects (foreign_product) fail-closed when cart context is absent', async () => {
    const promo = mockPromo(activePercent({ metadata: { scoped_product_id: 'prod_print' } }))
    const resolution = await resolveCouponForCheckout(promo, 'LIBRO50', allowed, 4000)
    expect(resolution).toEqual({ ok: false, reason: 'foreign_product' })
  })

  it('a NON-scoped coupon is unchanged — discounts the whole order base', async () => {
    const promo = mockPromo(activePercent()) // no metadata scope
    const resolution = await resolveCouponForCheckout(promo, 'LIBRO50', allowed, 4000, {
      productIds: ['prod_other'],
      productSubtotals: { prod_other: 4000 },
    })
    expect(resolution.ok).toBe(true)
    if (resolution.ok) {
      expect(resolution.discount_cents).toBe(2000) // 50% of 4000
      expect(resolution.scoped_product_id).toBeNull()
    }
  })

  it('still enforces foreign_seller / inactive / expired before scope', async () => {
    const foreign = mockPromo(activePercent({ metadata: { scoped_product_id: 'prod_print' } }))
    // id not in allowed list
    expect(await resolveCouponForCheckout(foreign, 'LIBRO50', ['other_id'], 1000, { productIds: ['prod_print'], productSubtotals: { prod_print: 1000 } }))
      .toEqual({ ok: false, reason: 'foreign_seller' })

    const expired = mockPromo(activePercent({ metadata: { scoped_product_id: 'prod_print' }, campaign: { ends_at: '2000-01-01T00:00:00Z', budget: null } }))
    expect(await resolveCouponForCheckout(expired, 'LIBRO50', allowed, 1000, { productIds: ['prod_print'], productSubtotals: { prod_print: 1000 } }))
      .toEqual({ ok: false, reason: 'expired' })
  })
})

describe('computeCouponDiscountCents (regression)', () => {
  it('percentage never exceeds the base and rounds', () => {
    expect(computeCouponDiscountCents('percentage', 50, 1000)).toBe(500)
    expect(computeCouponDiscountCents('percentage', 200, 1000)).toBe(1000) // clamped to base
    expect(computeCouponDiscountCents('fixed', 5, 1000)).toBe(500) // 5 MXN → 500 cents
  })
})
