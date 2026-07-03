/**
 * Public webhook — inbound Mercado Libre stock sync (Sprint 4 · US-11). ML calls
 * this URL on each order/item change; an ML **sale** decrements the linked Medusa
 * product's inventory so Miyagi reflects it and never oversells.
 *
 *   POST /webhooks/mercadolibre   body: { topic, user_id, resource }
 *
 * Design — **delta, exactly-once, Medusa as source of truth** (NOT absolute
 * reconcile, which can't recover concurrent independent sales):
 *  - Act on the `orders_v2` topic (a sale). Read the order's per-item sold
 *    quantities and **decrement** Medusa available by that many units
 *    (`applySale` → clamped ≥ 0, preserves Medusa reservations). A delta composes
 *    correctly with a simultaneous Miyagi sale; an absolute set would double-count.
 *  - **Idempotent per ML order id** (a durable `ml_applied_order` DB row, ml-
 *    orders-native S1 · US-0): a redelivered notification, or the reconcile poll
 *    surfacing the same order, applies once. (The order id — not the notification
 *    `_id` — is the exactly-once key; distinct sales of one item must not
 *    collapse to a replay.)
 *  - Gated by the global `ml.sync_enabled` kill-switch + the per-seller enable;
 *    unknown user / unlinked item / disabled seller → clean 200 ignore.
 *  - Always ACK 200 (except a malformed body); the reconcile job recovers any gap.
 *  - (S1 · US-1) When `ml.orders_enabled` is also on, the SAME apply additionally
 *    materializes a real Medusa order — see `applyMlOrderToLink` for how the two
 *    effects stay coupled (never a decrement without a record, never an order
 *    without the decrement that funded it).
 *
 * Public by design (ML has no shared secret): validated by mapping `user_id` to a
 * connected seller and reading the order from ML with that seller's token. The
 * token never leaves the module.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { isEnabled } from '../../../lib/flags'
import { MERCADOLIBRE_MODULE } from '../../../modules/mercadolibre'
import MercadolibreModuleService from '../../../modules/mercadolibre/service'
import { applyMlOrderToLink } from '../../../lib/ml-sync-apply'
import { isSoldOrderStatus } from '../../../modules/mercadolibre/sync-utils'

const ACK = { received: true }

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = (req.body ?? {}) as { topic?: string; user_id?: string | number; resource?: string }
  const { topic, user_id, resource } = body

  try {
    // Global kill-switch (fail-closed) — a flag-store outage halts inbound sync too.
    if (!(await isEnabled('ml.sync_enabled'))) return res.status(200).json({ ...ACK, ignored: 'sync_disabled' })
    // Only a sale (orders_v2) mutates stock. `items` (price/status/manual ML stock)
    // is not a delta we can apply safely → ignore for stock this sprint.
    if (!user_id || topic !== 'orders_v2') return res.status(200).json({ ...ACK, ignored: 'topic' })

    const orderMatch = /\/orders\/([^/?]+)/.exec(resource ?? '')
    if (!orderMatch) return res.status(200).json({ ...ACK, ignored: 'no_order' })
    const orderId = orderMatch[1]

    const ml = req.scope.resolve(MERCADOLIBRE_MODULE) as MercadolibreModuleService
    const conn = await ml.getConnectionByMlUser(String(user_id))
    if (!conn) return res.status(200).json({ ...ACK, ignored: 'unknown_user' })
    if (!(await ml.isSellerSyncEnabled(conn.seller_id))) {
      return res.status(200).json({ ...ACK, ignored: 'seller_disabled' })
    }

    const { status, items: soldItems, raw: rawOrder } = await ml.getMlOrderItems(conn.seller_id, orderId)
    // Only a paid order consumed stock — a payment_required/cancelled order must not
    // decrement (a later `paid` notification applies then, idempotent per order id).
    if (!isSoldOrderStatus(status)) return res.status(200).json({ ...ACK, ignored: 'not_paid' })

    // ml-orders-native S1 · US-1: materialize a Medusa order alongside the stock
    // decrement, dark behind the global flag. The seller's token is only needed
    // on this path (the shipment-detail fetch), so it's fetched once here rather
    // than inside the per-item loop/lock.
    const ordersEnabled = await isEnabled('ml.orders_enabled')
    const sellerAccessToken = ordersEnabled ? await ml.getAccessTokenForSeller(conn.seller_id) : null

    const applied: string[] = []
    for (const { mlItemId, quantity } of soldItems) {
      try {
        const link = await ml.getLinkByMlItem(mlItemId)
        if (!link || link.seller_id !== conn.seller_id) continue // unlinked → clean ignore
        // Atomic, exactly-once decrement (serialized per link; re-checks inside the lock).
        const result = await applyMlOrderToLink(
          req.scope,
          ml,
          link,
          orderId,
          quantity,
          ordersEnabled,
          rawOrder,
          sellerAccessToken,
        )
        if (result === 'applied') applied.push(mlItemId)
      } catch (e) {
        console.error('[ml-webhook] apply failed', mlItemId, orderId, e)
        // leave unapplied → the reconcile job's order poll recovers it
      }
    }

    return res.status(200).json({ ...ACK, applied })
  } catch (e) {
    console.error('[ml-webhook] error', e)
    return res.status(200).json({ ...ACK, error: true })
  }
}
