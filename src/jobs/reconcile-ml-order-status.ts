/**
 * Scheduled job: reconcile-ml-order-status (ml-orders-native S1 · US-2)
 *
 * Keeps a materialized Medusa order's `fulfillment_status` in step with the real
 * ML order/shipment lifecycle (paid → shipped → delivered). Every 30 min, for
 * every non-terminal Medusa order on the "Mercado Libre" channel (found via
 * `metadata.source = 'mercadolibre'`, stamped by `materializeMlOrder`):
 *   1. Fetch the ML order's current status + its shipment's current status.
 *   2. Map to a fulfillment transition (`mapMlOrderStatusToFulfillment`, pure),
 *      applied ONLY if it's a forward move (`shouldApplyFulfillmentTransition` —
 *      replay-safe, never regresses).
 *
 * SCOPE NOTE (Sprint 1): reconcile-poll-driven only (≤30 min latency). Mercado
 * Libre exposes a distinct `shipments` webhook topic for real-time shipment
 * updates, but subscribing to it requires an ML-developer-portal config change
 * this session couldn't make or verify — a stated gap, not an oversight. Wiring
 * that topic into `webhooks/mercadolibre/route.ts` (which today only reacts to
 * `orders_v2`) is a clean fast-follow once the ML app is subscribed.
 *
 * Gated by the SAME kill-switch as the rest of the sync (`ml.sync_enabled`) PLUS
 * `ml.orders_enabled` — this job has nothing to do without materialized orders.
 *
 * Finds candidate orders via a raw metadata query (mirrors the established
 * `metadata->>'x' = ?` pattern in `clerk-auth.ts`'s `resolveOrCreateBuyerCustomer`
 * — Medusa's `query.graph` filters don't reach into a JSONB `metadata` column),
 * then re-fetches each candidate's items/fulfillments via the supported
 * `query.graph` API.
 */

import { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { isEnabled } from '../lib/flags'
import { tgNotifyAdmin, esc } from '../lib/telegram'
import { MERCADOLIBRE_MODULE } from '../modules/mercadolibre'
import MercadolibreModuleService from '../modules/mercadolibre/service'
import { getShipmentDetail } from '../modules/mercadolibre/client'
import { mapMlOrderStatusToFulfillment, shouldApplyFulfillmentTransition } from '../modules/mercadolibre/sync-utils'
import { applyMlFulfillmentTransition } from '../lib/ml-fulfillment-apply'

const MAX_ORDERS_PER_RUN = 500
// Real Medusa FulfillmentStatus values that mean "nothing left to track."
const TERMINAL_STATUSES = new Set(['delivered', 'partially_delivered', 'canceled'])

type CandidateRow = { id: string; fulfillment_status: string | null; metadata: Record<string, unknown> | null }

export default async function reconcileMlOrderStatusJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  if (!(await isEnabled('ml.sync_enabled'))) return // shares the sync kill-switch (fail-closed)
  if (!(await isEnabled('ml.orders_enabled'))) return // nothing materialized without it

  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const { rows: candidates } = (await knex.raw(
    `select id, fulfillment_status, metadata from "order"
     where metadata->>'source' = 'mercadolibre'
       and deleted_at is null
       and (fulfillment_status is null or fulfillment_status not in ('delivered','partially_delivered','canceled'))
     order by created_at asc
     limit ?`,
    [MAX_ORDERS_PER_RUN],
  )) as { rows: CandidateRow[] }

  if (candidates.length === 0) return

  const ml = container.resolve(MERCADOLIBRE_MODULE) as MercadolibreModuleService
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  let advanced = 0
  const alerts: string[] = []
  // Multiple candidates commonly share a seller — cache the access token per run
  // instead of re-fetching (and potentially re-refreshing) it once per order.
  const tokenCache = new Map<string, Promise<string>>()
  function tokenForSeller(sellerId: string): Promise<string> {
    let cached = tokenCache.get(sellerId)
    if (!cached) {
      cached = ml.getAccessTokenForSeller(sellerId)
      tokenCache.set(sellerId, cached)
    }
    return cached
  }

  for (const candidate of candidates) {
    if (candidate.fulfillment_status && TERMINAL_STATUSES.has(candidate.fulfillment_status)) continue
    const meta = candidate.metadata ?? {}
    const mlOrderId = meta.ml_order_id as string | undefined
    const sellerId = meta.ml_seller_id as string | undefined
    if (!mlOrderId || !sellerId) continue

    try {
      const { status: mlOrderStatus, raw } = await ml.getMlOrderItems(sellerId, mlOrderId)
      const shippingId = raw?.shipping?.id
      let shipmentStatus: string | null = null
      if (shippingId != null) {
        const token = await tokenForSeller(sellerId)
        const shipment = await getShipmentDetail(token, shippingId)
        shipmentStatus = (shipment as { status?: string } | null)?.status ?? null
        // `getShipmentDetail` swallows its own errors (best-effort by contract) —
        // ML told us a shipment exists (`shippingId` present) but we couldn't read
        // it, which is a REAL fetch failure, not "no shipment yet." Surface it so a
        // persistent auth/API problem pages someone instead of silently stalling
        // this order's status forever (cross-review should-fix).
        if (shipment == null) {
          alerts.push(`• order ${esc(candidate.id)} (ML ${esc(mlOrderId)}): shipment ${esc(String(shippingId))} fetch failed`)
        }
      }

      const target = mapMlOrderStatusToFulfillment(mlOrderStatus, shipmentStatus)
      if (!target || !shouldApplyFulfillmentTransition(candidate.fulfillment_status, target)) continue

      const { data } = await query.graph({
        entity: 'order',
        fields: ['id', 'items.id', 'items.quantity', 'fulfillments.id'],
        filters: { id: candidate.id },
      })
      const order = data?.[0] as { items?: { id: string; quantity: number }[]; fulfillments?: { id: string }[] } | undefined
      if (!order) continue

      const result = await applyMlFulfillmentTransition(container as never, {
        orderId: candidate.id,
        target,
        items: (order.items ?? []).map((i) => ({ id: i.id, quantity: i.quantity ?? 1 })),
        fulfillmentId: order.fulfillments?.[0]?.id ?? null,
      })
      if (result.applied) {
        advanced++
        logger.info(`[reconcile-ml-order-status] ${candidate.id} → ${target}`)
        await ml.recordSyncEvent({
          sellerId,
          kind: 'reconcile',
          outcome: 'ok',
          code: target,
          message: `Estado de pedido de Mercado Libre actualizado: ${target} (pedido ${candidate.id})`,
          metadata: { ml_order_id: mlOrderId, medusa_order_id: candidate.id },
        })
      }
    } catch (e) {
      alerts.push(
        `• order ${esc(candidate.id)} (ML ${esc(mlOrderId)}): status reconcile failed — ${esc(
          e instanceof Error ? e.message : String(e),
        )}`,
      )
    }
  }

  if (advanced > 0 || alerts.length > 0) {
    logger.info(`[reconcile-ml-order-status] advanced=${advanced} alerts=${alerts.length}`)
  }
  if (alerts.length > 0) {
    await tgNotifyAdmin(`⚠️ <b>ML order status sync</b> — ${alerts.length} issue(s):\n${alerts.slice(0, 20).join('\n')}`)
  }
}

export const config = {
  name: 'reconcile-ml-order-status',
  schedule: '*/30 * * * *',
}
