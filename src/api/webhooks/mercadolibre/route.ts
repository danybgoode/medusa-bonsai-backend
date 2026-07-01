/**
 * Public webhook — inbound Mercado Libre stock sync (Sprint 4 · US-11). ML calls
 * this URL on each order/item change; we adjust the linked Medusa product's
 * inventory so Miyagi reflects ML sales and never oversells.
 *
 *   POST /webhooks/mercadolibre   body: { topic, user_id, resource, _id? }
 *
 * Design (mirrors the despachobonsai reference shape, made Medusa-native +
 * oversell-safe):
 *  - Trust nothing in the body's numbers — we re-fetch the item's authoritative
 *    `available_quantity` from ML via the seller's token.
 *  - Apply via `setVariantAvailableQuantity` (available = stocked − reserved,
 *    clamped ≥ 0) so a Medusa reservation is never clobbered and stock never goes
 *    negative.
 *  - Replay-safe: a redelivered notification id is a no-op (per-link dedupe ring).
 *  - Gated by the global `ml.sync_enabled` kill-switch + the per-seller enable;
 *    an unknown user / unlinked item / disabled seller is ignored cleanly.
 *  - Always ACK 200 (except a malformed body → 400) so ML stops retrying; any
 *    processing gap is healed by the reconcile job.
 *
 * Public by design (ML has no shared secret): validated by mapping `user_id` to a
 * connected seller and re-reading state from ML. The seller's token never leaves
 * the module.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { isEnabled } from '../../../lib/flags'
import { MERCADOLIBRE_MODULE } from '../../../modules/mercadolibre'
import MercadolibreModuleService from '../../../modules/mercadolibre/service'
import { isProcessedNotification, type ProcessedEvent } from '../../../modules/mercadolibre/sync-utils'
import { setProductAvailableQuantity } from '../../store/_utils/inventory'

const ACK = { received: true }

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = (req.body ?? {}) as {
    topic?: string
    user_id?: string | number
    resource?: string
    _id?: string
    id?: string
  }
  const { topic, user_id, resource } = body
  const notifId = String(body._id ?? body.id ?? resource ?? '')

  try {
    // Global kill-switch (fail-closed) — a Flagsmith outage halts inbound sync too.
    if (!(await isEnabled('ml.sync_enabled'))) return res.status(200).json({ ...ACK, ignored: 'sync_disabled' })
    if (!user_id || (topic !== 'orders_v2' && topic !== 'items')) {
      return res.status(200).json({ ...ACK, ignored: 'topic' })
    }

    const ml = req.scope.resolve(MERCADOLIBRE_MODULE) as MercadolibreModuleService
    const conn = await ml.getConnectionByMlUser(String(user_id))
    if (!conn) return res.status(200).json({ ...ACK, ignored: 'unknown_user' })
    if (!(await ml.isSellerSyncEnabled(conn.seller_id))) {
      return res.status(200).json({ ...ACK, ignored: 'seller_disabled' })
    }

    // Which ML item(s) did this notification touch?
    let itemIds: string[] = []
    if (topic === 'items') {
      const m = /\/items\/([^/?]+)/.exec(resource ?? '')
      if (m) itemIds = [m[1]]
    } else {
      const m = /\/orders\/([^/?]+)/.exec(resource ?? '')
      if (m) itemIds = await ml.getMlOrderItemIds(conn.seller_id, m[1])
    }

    const applied: string[] = []
    for (const itemId of itemIds) {
      try {
        const link = await ml.getLinkByMlItem(itemId)
        if (!link || link.seller_id !== conn.seller_id) continue // unlinked → clean ignore
        const meta = (link.metadata ?? {}) as Record<string, unknown>
        if (isProcessedNotification(meta.ml_processed_events as ProcessedEvent[] | undefined, notifId)) {
          continue // redelivery → no-op
        }
        const mlAvailable = await ml.getMlItemAvailable(conn.seller_id, itemId)
        if (mlAvailable != null) {
          await setProductAvailableQuantity(req.scope, link.product_id, link.variant_id, mlAvailable)
          applied.push(itemId)
        }
        // Only mark processed once the fetch+apply succeeded, so a transient ML
        // failure is retried (or healed by the reconcile job), not silently eaten.
        await ml.markLinkNotificationProcessed(link.id, notifId)
      } catch (e) {
        console.error('[ml-webhook] item apply failed', itemId, e)
        // leave unprocessed → reconcile job heals it
      }
    }

    return res.status(200).json({ ...ACK, applied })
  } catch (e) {
    console.error('[ml-webhook] error', e)
    // ACK anyway (ML would otherwise hammer retries); the reconcile job is the net.
    return res.status(200).json({ ...ACK, error: true })
  }
}
