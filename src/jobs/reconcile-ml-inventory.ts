/**
 * Scheduled job: reconcile-ml-inventory (Sprint 4 · US-12)
 *
 * The safety net for the two-way ML stock sync, in the delta / source-of-truth
 * model. Every 30 min, for each linked + sync-enabled seller it:
 *   1. **Recovers missed ML sales** — polls the seller's ML orders since the last
 *      marker and applies any not-yet-applied order as a delta (idempotent per ML
 *      order id), exactly as the webhook would. This is what makes the sync robust
 *      against a dropped/never-delivered webhook.
 *   2. **Mirrors Medusa → ML** — pushes each linked item's current Medusa available
 *      (the source of truth, after all reservations + applied ML sales) out to ML,
 *      so ML never advertises more than truly exists.
 * Raises a **drift alert** (Telegram) when it can't reach ML for a seller/item.
 *
 * Gated by the global `ml.sync_enabled` kill-switch: flip it OFF and this job (and
 * all live sync) halts immediately.
 */

import { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { isEnabled } from '../lib/flags'
import { tgNotifyAdmin, esc } from '../lib/telegram'
import { MERCADOLIBRE_MODULE } from '../modules/mercadolibre'
import MercadolibreModuleService from '../modules/mercadolibre/service'
import { applyMlOrderToLink } from '../lib/ml-sync-apply'
import { getProductAvailableQuantity } from '../api/store/_utils/inventory'

const MAX_LINKS_PER_RUN = 2000
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000 // no marker yet → scan the last 24h
const OVERLAP_MS = 5 * 60 * 1000 // re-scan a small window each run (idempotent) to cover boundaries

type Link = {
  id: string
  seller_id: string
  product_id: string
  variant_id?: string | null
  ml_item_id: string
  metadata?: Record<string, unknown> | null
}

export default async function reconcileMlInventoryJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  if (!(await isEnabled('ml.sync_enabled'))) return // global kill-switch (fail-closed)

  const ml = container.resolve(MERCADOLIBRE_MODULE) as MercadolibreModuleService
  const allLinks = (await ml.listProductMlLinks({}, { take: MAX_LINKS_PER_RUN })) as Link[]

  // Active links grouped by sync-enabled seller.
  const bySeller = new Map<string, Link[]>()
  const enabledCache = new Map<string, boolean>()
  for (const link of allLinks) {
    const meta = (link.metadata ?? {}) as Record<string, unknown>
    if (meta.ml_status && meta.ml_status !== 'active') continue
    if (!enabledCache.has(link.seller_id)) {
      enabledCache.set(link.seller_id, await ml.isSellerSyncEnabled(link.seller_id))
    }
    if (!enabledCache.get(link.seller_id)) continue
    const list = bySeller.get(link.seller_id) ?? []
    list.push(link)
    bySeller.set(link.seller_id, list)
  }

  let recovered = 0
  let mirrored = 0
  const alerts: string[] = []

  for (const [sellerId, links] of bySeller) {
    const linkByItem = new Map(links.map((l) => [l.ml_item_id, l]))

    // ── 1. Recover missed ML sales (delta, idempotent per order id) ──────────────
    const nowIso = new Date().toISOString()
    try {
      const marker = await ml.getSellerSyncMarker(sellerId)
      const since = new Date(
        (marker ? new Date(marker).getTime() : Date.now() - FIRST_RUN_LOOKBACK_MS) - OVERLAP_MS,
      ).toISOString()
      const { orders, truncated } = await ml.searchSellerOrdersSince(sellerId, since)
      for (const order of orders) {
        for (const { mlItemId, quantity } of order.items) {
          const link = linkByItem.get(mlItemId)
          if (!link) continue
          const result = await applyMlOrderToLink(container as never, ml, link, order.id, quantity)
          if (result === 'applied') {
            recovered++
            logger.info(`[reconcile-ml-inventory] recovered ML order ${order.id} on ${mlItemId}`)
          }
        }
      }
      // Only advance the marker when we drained the window; if the page was
      // truncated (more orders than we paged), keep the old marker so the next run
      // re-scans — no missed order is ever skipped (application is idempotent).
      if (!truncated) await ml.setSellerSyncMarker(sellerId, nowIso)
    } catch (e) {
      alerts.push(`• seller ${esc(sellerId)}: ML order poll failed — ${esc(e instanceof Error ? e.message : String(e))}`)
    }

    // ── 2. Mirror Medusa → ML (ML never advertises more than Medusa's truth) ─────
    for (const link of links) {
      try {
        const current = await getProductAvailableQuantity(container as never, link.product_id)
        if (current == null) continue
        const r = await ml.pushStockToMl({ productId: link.product_id, availableQuantity: current, force: true })
        if (r.action === 'push') mirrored++
        if (r.action === 'deferred') {
          alerts.push(`• ${esc(link.ml_item_id)}: ML push deferred (rate-limit / error)`)
        }
      } catch (e) {
        alerts.push(`• ${esc(link.ml_item_id)}: mirror push failed — ${esc(e instanceof Error ? e.message : String(e))}`)
      }
    }
  }

  if (recovered > 0 || mirrored > 0 || alerts.length > 0) {
    logger.info(`[reconcile-ml-inventory] recovered=${recovered} mirrored=${mirrored} alerts=${alerts.length}`)
  }
  if (alerts.length > 0) {
    await tgNotifyAdmin(`⚠️ <b>ML stock sync</b> — ${alerts.length} issue(s):\n${alerts.slice(0, 20).join('\n')}`)
  }
}

export const config = {
  name: 'reconcile-ml-inventory',
  schedule: '*/30 * * * *',
}
