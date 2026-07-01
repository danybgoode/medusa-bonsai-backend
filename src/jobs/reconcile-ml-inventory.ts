/**
 * Scheduled job: reconcile-ml-inventory (Sprint 4 · US-12)
 *
 * The safety net + drift-healer for the two-way ML stock sync. Every 30 min, for
 * each linked + sync-enabled item, it compares Medusa's available quantity with
 * ML's and corrects any drift toward the **conservative minimum** (`reconcileStock`
 * — never exceeds either side, never negative → no oversell). It also retries any
 * outbound push that a live subscriber deferred on an ML rate-limit, and raises a
 * **drift alert** (Telegram) when it can't read/reconcile a linked item.
 *
 * Gated by the global `ml.sync_enabled` kill-switch: flip it OFF and this job (and
 * all live sync) halts immediately. Ships with the live sync, not after it.
 */

import { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { isEnabled } from '../lib/flags'
import { tgNotifyAdmin, esc } from '../lib/telegram'
import { MERCADOLIBRE_MODULE } from '../modules/mercadolibre'
import MercadolibreModuleService from '../modules/mercadolibre/service'
import { reconcileStock } from '../modules/mercadolibre/sync-utils'
import {
  getProductAvailableQuantity,
  setProductAvailableQuantity,
} from '../api/store/_utils/inventory'

const MAX_LINKS_PER_RUN = 2000

export default async function reconcileMlInventoryJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  // Global kill-switch (fail-closed): OFF halts all reconciliation.
  if (!(await isEnabled('ml.sync_enabled'))) return

  const ml = container.resolve(MERCADOLIBRE_MODULE) as MercadolibreModuleService
  const links = await ml.listProductMlLinks({}, { take: MAX_LINKS_PER_RUN })

  // Cache the per-seller enable so we resolve each connection at most once.
  const syncEnabled = new Map<string, boolean>()
  const isSellerOn = async (sellerId: string): Promise<boolean> => {
    if (!syncEnabled.has(sellerId)) syncEnabled.set(sellerId, await ml.isSellerSyncEnabled(sellerId))
    return syncEnabled.get(sellerId)!
  }

  let checked = 0
  let corrected = 0
  const driftAlerts: string[] = []

  for (const link of links as {
    id: string
    seller_id: string
    product_id: string
    variant_id?: string | null
    ml_item_id: string
    metadata?: Record<string, unknown> | null
  }[]) {
    const meta = (link.metadata ?? {}) as Record<string, unknown>
    // Only reconcile an ACTIVE linked item for a sync-enabled seller.
    if (meta.ml_status && meta.ml_status !== 'active') continue
    if (!(await isSellerOn(link.seller_id))) continue

    try {
      const medusaAvailable = await getProductAvailableQuantity(container as never, link.product_id)
      if (medusaAvailable == null) continue // no managed inventory to reconcile

      const mlAvailable = await ml.getMlItemAvailable(link.seller_id, link.ml_item_id)
      if (mlAvailable == null) {
        driftAlerts.push(`• ${esc(link.ml_item_id)}: no ML quantity readable (Medusa=${medusaAvailable})`)
        continue
      }

      checked++
      const { target, drift } = reconcileStock({ medusaAvailable, mlAvailable })
      if (drift === 0) continue

      // Correct the side(s) that sit above the conservative target. Never raises a
      // side (that could oversell) — only lowers toward the safe minimum.
      if (target < medusaAvailable) {
        await setProductAvailableQuantity(container as never, link.product_id, link.variant_id, target)
      }
      if (target < mlAvailable) {
        await ml.pushStockToMl({ productId: link.product_id, availableQuantity: target, force: true })
      }
      corrected++
      logger.info(
        `[reconcile-ml-inventory] healed ${link.ml_item_id}: Medusa=${medusaAvailable} ML=${mlAvailable} → ${target}`,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      driftAlerts.push(`• ${esc(link.ml_item_id)}: reconcile failed — ${esc(msg)}`)
    }
  }

  if (corrected > 0 || driftAlerts.length > 0) {
    logger.info(`[reconcile-ml-inventory] checked=${checked} corrected=${corrected} alerts=${driftAlerts.length}`)
  }
  if (driftAlerts.length > 0) {
    await tgNotifyAdmin(
      `⚠️ <b>ML stock drift</b> — ${driftAlerts.length} item(s) could not be reconciled:\n${driftAlerts.slice(0, 20).join('\n')}`,
    )
  }
}

export const config = {
  name: 'reconcile-ml-inventory',
  schedule: '*/30 * * * *',
}
