/**
 * Notify the seller of an ML order lifecycle event (ml-orders-native S2 · US-5).
 *
 * Resolves `clerk_user_id` in-process via the backend's own `Seller` module
 * (`SellerModuleService`) — no Supabase round-trip needed, since `clerk_user_id`
 * is already a first-class field there, and `ml_connection.seller_id`/
 * `product_ml_link.seller_id` already ARE that same Medusa `seller.id`.
 *
 * Calls the frontend the same way `jobs/reconcile-checkouts.ts` and
 * `jobs/sweepstakes-draw.ts` already do: `${SITE_URL}/api/...` with
 * `x-internal-secret: MEDUSA_INTERNAL_SECRET`. Never throws — a notification
 * failure must never break materialization/fulfillment/cancel, mirroring
 * `recordSyncEvent`'s own never-throw contract.
 */

import { SELLER_MODULE } from '../modules/seller'
import type SellerModuleService from '../modules/seller/service'

type Scope = { resolve: (key: string) => any }

const SITE_URL = process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'

export type MlNotifyEvent = 'ml_order_new' | 'ml_order_shipped' | 'ml_order_delivered' | 'ml_order_cancelled'

export async function notifySellerOfMlOrderEvent(
  scope: Scope,
  sellerId: string,
  event: MlNotifyEvent,
  medusaOrderId: string,
): Promise<void> {
  const secret = process.env.MEDUSA_INTERNAL_SECRET
  if (!secret) return // not configured — skip silently, same as the reconcile-checkouts job

  try {
    const sellerService: SellerModuleService = scope.resolve(SELLER_MODULE)
    const [seller] = await sellerService.listSellers({ id: sellerId } as never, { take: 1 })
    const clerkUserId = (seller as { clerk_user_id?: string | null } | undefined)?.clerk_user_id
    if (!clerkUserId) return // unclaimed shop — no account to notify

    const res = await fetch(`${SITE_URL}/api/internal/ml/notify-seller`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
      body: JSON.stringify({ clerkUserId, event, orderId: medusaOrderId }),
    })
    // fetch() only rejects on a network-level failure — a non-2xx HTTP response
    // (wrong secret, a 500 on the frontend) resolves normally and would otherwise
    // be silently treated as "delivered." Log it (still never throw further).
    if (!res.ok) {
      console.error(`[ml-notify-seller] notify-seller returned ${res.status} for order ${medusaOrderId}`)
    }
  } catch (e) {
    console.error('[ml-notify-seller] failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}
