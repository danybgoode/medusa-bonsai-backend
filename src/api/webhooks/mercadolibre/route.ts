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
 *  - **Idempotent per ML order id** (a bounded ring of applied order ids on the
 *    linkage): a redelivered notification, or the reconcile poll surfacing the
 *    same order, applies once. (The order id — not the notification `_id` — is the
 *    exactly-once key; distinct sales of one item must not collapse to a replay.)
 *  - Gated by the global `ml.sync_enabled` kill-switch + the per-seller enable;
 *    unknown user / unlinked item / disabled seller → clean 200 ignore.
 *  - Always ACK 200 (except a malformed body); the reconcile job recovers any gap.
 *
 * Public by design (ML has no shared secret): validated by mapping `user_id` to a
 * connected seller and reading the order from ML with that seller's token. The
 * token never leaves the module.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { isEnabled } from '../../../lib/flags'
import { MERCADOLIBRE_MODULE } from '../../../modules/mercadolibre'
import MercadolibreModuleService from '../../../modules/mercadolibre/service'
import { applySale, isOrderApplied, type AppliedOrder } from '../../../modules/mercadolibre/sync-utils'
import { getProductAvailableQuantity, setProductAvailableQuantity } from '../../store/_utils/inventory'

const ACK = { received: true }

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = (req.body ?? {}) as { topic?: string; user_id?: string | number; resource?: string }
  const { topic, user_id, resource } = body

  try {
    // Global kill-switch (fail-closed) — a Flagsmith outage halts inbound sync too.
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

    const soldItems = await ml.getMlOrderItems(conn.seller_id, orderId)
    const applied: string[] = []
    for (const { mlItemId, quantity } of soldItems) {
      try {
        const link = await ml.getLinkByMlItem(mlItemId)
        if (!link || link.seller_id !== conn.seller_id) continue // unlinked → clean ignore
        const meta = (link.metadata ?? {}) as Record<string, unknown>
        if (isOrderApplied(meta.ml_applied_orders as AppliedOrder[] | undefined, orderId)) continue // already applied
        if (quantity <= 0) {
          await ml.markOrderAppliedForLink(link.id, orderId, 0) // record so we don't re-poll it; no stock change
          continue
        }
        const current = await getProductAvailableQuantity(req.scope, link.product_id)
        if (current == null) continue // no managed inventory to decrement
        const next = applySale(current, quantity)
        await setProductAvailableQuantity(req.scope, link.product_id, link.variant_id, next)
        await ml.markOrderAppliedForLink(link.id, orderId, next)
        applied.push(mlItemId)
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
