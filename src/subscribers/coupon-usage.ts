/**
 * Registers seller-coupon usage when an order is actually placed.
 *
 * Why a subscriber: our carts don't run through Medusa's promotion engine
 * (start-checkout bills providers with a computed priceCents), so the native
 * registerUsageStep inside completeCart sees no promotions for our coupons.
 * Instead, start-checkout stamps `coupon` onto cart.metadata, which Medusa's
 * complete-cart workflow copies to order.metadata. Listening on `order.placed`
 * means usage is counted once, for every payment path (card / MP / manual),
 * and only after the order exists — never on an abandoned checkout.
 */

import type { SubscriberArgs, SubscriberConfig } from '@medusajs/framework'
import { Modules } from '@medusajs/framework/utils'
import { IOrderModuleService, IPromotionModuleService } from '@medusajs/framework/types'

type CouponMeta = { code?: string; promotion_id?: string; discount_cents?: number }

export default async function registerCouponUsage({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const orderService = container.resolve(Modules.ORDER) as IOrderModuleService
  const order = await orderService.retrieveOrder(data.id)

  const metadata = (order.metadata ?? {}) as Record<string, unknown>
  const coupon = metadata.coupon as CouponMeta | undefined
  if (!coupon?.code || metadata.coupon_usage_registered) return

  const promotionService = container.resolve(Modules.PROMOTION) as IPromotionModuleService
  try {
    await promotionService.registerUsage(
      [{ code: coupon.code, amount: Number(coupon.discount_cents ?? 0) }],
      { customer_id: order.customer_id ?? null, customer_email: order.email ?? null },
    )
    // Idempotency guard against any redelivery of order.placed.
    await orderService.updateOrders([
      { id: order.id, metadata: { ...metadata, coupon_usage_registered: true } },
    ])
  } catch (e) {
    console.error('[coupon-usage] registerUsage failed for order', order.id, e)
  }
}

export const config: SubscriberConfig = {
  event: 'order.placed',
}
