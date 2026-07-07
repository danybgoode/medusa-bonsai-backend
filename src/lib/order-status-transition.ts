/**
 * Order fulfillment-status transition — extracted from the single-order PATCH
 * `store/sellers/me/orders/[id]/route.ts` (ml-orders-native S3 · US-8) so a new
 * bulk-status endpoint can reuse the exact same two-workflow dance + manual-
 * payment gate instead of a third copy (see `lib/ml-fulfillment-apply.ts` for
 * the ML-reconcile-job's existing near-duplicate — this does NOT touch that
 * file, just stops this specific logic from growing a third instance).
 *
 * Behavior-preserving extraction: callers still do their own auth + ownership
 * check + order fetch (each route's ownership-resolution shape differs
 * slightly) and pass the already-fetched `order` (must include `metadata`,
 * `items`, `fulfillments`) in.
 */

import { MedusaContainer } from '@medusajs/framework/types'
import { Modules } from '@medusajs/framework/utils'
import {
  createOrderFulfillmentWorkflow,
  createOrderShipmentWorkflow,
  markOrderFulfillmentAsDeliveredWorkflow,
} from '@medusajs/medusa/core-flows'
import { resolveShippingOptionIds, resolveStockLocationId } from '../api/store/_utils/fulfillment'

export const LIFECYCLE_STATES = new Set(['processing', 'shipped', 'in_transit', 'delivered', 'completed'])

export type OrderStatusTransitionBody = {
  carrier?: string
  carrier_label?: string
  tracking_number?: string
}

/**
 * Pure — the manual-payment eligibility gate, extracted so the bulk-status
 * endpoint's "ineligible order reports why" acceptance is unit-testable
 * without DB/scope (the sprint's named "bulk-action eligibility fn").
 */
export function isOrderEligibleForBulkStatus(
  meta: Record<string, unknown>,
  newStatus: string,
): { eligible: true } | { eligible: false; reason: string } {
  if (
    (newStatus === 'shipped' || newStatus === 'in_transit') &&
    ['manual', 'spei', 'cash', 'dimo'].includes((meta.payment_method as string) ?? '') &&
    meta.payment_received !== true
  ) {
    return { eligible: false, reason: 'Aún no confirmas el pago de este pedido.' }
  }
  return { eligible: true }
}

export async function applyOrderStatusTransition(
  scope: MedusaContainer,
  args: {
    orderId: string
    order: Record<string, unknown>
    newStatus: string
    body?: OrderStatusTransitionBody
  },
): Promise<{ ok: true } | { ok: false; status: 422 | 500; message: string }> {
  const { orderId, order, newStatus, body = {} } = args
  const orderService = (scope as any).resolve(Modules.ORDER) as any
  const meta = (order.metadata ?? {}) as Record<string, any>

  const eligibility = isOrderEligibleForBulkStatus(meta, newStatus)
  if (!eligibility.eligible) {
    return { ok: false, status: 422, message: eligibility.reason }
  }

  const prevShipment = (meta.shipment ?? {}) as Record<string, any>
  const now = new Date().toISOString()

  let shipment = prevShipment
  if (newStatus === 'shipped' || newStatus === 'in_transit') {
    shipment = {
      ...prevShipment,
      carrier: body.carrier ?? prevShipment.carrier ?? 'manual',
      carrier_label: body.carrier_label ?? prevShipment.carrier_label ?? null,
      tracking_number: body.tracking_number ?? prevShipment.tracking_number ?? null,
      status: newStatus === 'in_transit' ? 'in_transit' : 'shipped',
      shipped_at: prevShipment.shipped_at ?? now,
      created_at: prevShipment.created_at ?? now,
    }
  } else if (newStatus === 'delivered') {
    shipment = { ...prevShipment, status: 'delivered', delivered_at: now }
  }

  // ── E-full: native Medusa fulfillment workflows (non-fatal, unchanged) ────
  if (newStatus === 'shipped' || newStatus === 'in_transit') {
    await runFulfillWorkflow({ scope, order, orderId, body, now })
  } else if (newStatus === 'delivered') {
    await runDeliveredWorkflow({ scope, order, orderId })
  }

  // ── Always: persist lifecycle state on order.metadata ────────────────────
  try {
    await orderService.updateOrders(orderId, {
      metadata: {
        ...meta,
        fulfillment_state: newStatus,
        ...(Object.keys(shipment).length ? { shipment } : {}),
        ...(newStatus === 'delivered' ? { delivered_at: now } : {}),
        ...(newStatus === 'completed' ? { completed_at: now } : {}),
      },
    })
  } catch (e) {
    console.error('[order-status-transition] status update error:', e)
    return { ok: false, status: 500, message: 'Failed to update order' }
  }

  return { ok: true }
}

// ── E-full helpers (moved verbatim from [id]/route.ts) ───────────────────────

async function runFulfillWorkflow({
  scope,
  order,
  orderId,
  body,
  now,
}: {
  scope: MedusaContainer
  order: Record<string, unknown>
  orderId: string
  body: OrderStatusTransitionBody
  now: string
}) {
  const fulfillments = (order.fulfillments as any[]) ?? []
  const existingFulfillment = fulfillments[0]

  if (existingFulfillment?.id) {
    await runShipmentWorkflow({ scope, orderId, fulfillmentId: existingFulfillment.id, order, body })
    return
  }

  const meta = (order.metadata ?? {}) as Record<string, any>
  const fulfillmentMethod = (meta.fulfillment_method ?? 'shipping') as string
  const optionKey = fulfillmentMethod === 'local_pickup' ? 'pickup'
    : fulfillmentMethod === 'digital' || fulfillmentMethod === 'service' ? 'digital'
    : fulfillmentMethod === 'none' || fulfillmentMethod === 'coord' || fulfillmentMethod === 'rental' ? 'coord'
    : 'shipping'

  const [optionIds, locationId] = await Promise.all([
    resolveShippingOptionIds(scope as any),
    resolveStockLocationId(scope as any),
  ])

  const shippingOptionId = optionIds[optionKey]
  if (!shippingOptionId) {
    console.warn('[order-status-transition] E-full skipped: shipping option not found, option_key=%s', optionKey)
    return
  }

  const items = ((order.items as any[]) ?? []).map((i: any) => ({ id: i.id, quantity: i.quantity ?? 1 }))
  if (!items.length) return

  try {
    const { result: fulfillment } = await createOrderFulfillmentWorkflow(scope as any).run({
      input: {
        order_id: orderId,
        items,
        shipping_option_id: shippingOptionId,
        ...(locationId ? { location_id: locationId } : {}),
        no_notification: true,
        metadata: { source: 'seller_patch', created_at: now },
      } as any,
    })

    if ((fulfillment as any)?.id && body.tracking_number) {
      await runShipmentWorkflow({ scope, orderId, fulfillmentId: (fulfillment as any).id, order, body })
    }
  } catch (e) {
    console.error('[order-status-transition] createOrderFulfillmentWorkflow error (non-fatal):', e)
  }
}

async function runShipmentWorkflow({
  scope,
  orderId,
  fulfillmentId,
  order,
  body,
}: {
  scope: MedusaContainer
  orderId: string
  fulfillmentId: string
  order: Record<string, unknown>
  body: OrderStatusTransitionBody
}) {
  if (!body.tracking_number) return

  const items = ((order.items as any[]) ?? []).map((i: any) => ({ id: i.id, quantity: i.quantity ?? 1 }))
  if (!items.length) return

  try {
    await createOrderShipmentWorkflow(scope as any).run({
      input: {
        order_id: orderId,
        fulfillment_id: fulfillmentId,
        items,
        no_notification: true,
        labels: [{
          tracking_number: body.tracking_number,
          tracking_url: '',
          label_url: '',
        }],
      } as any,
    })
  } catch (e) {
    console.error('[order-status-transition] createOrderShipmentWorkflow error (non-fatal):', e)
  }
}

async function runDeliveredWorkflow({
  scope,
  order,
  orderId,
}: {
  scope: MedusaContainer
  order: Record<string, unknown>
  orderId: string
}) {
  const fulfillments = (order.fulfillments as any[]) ?? []
  const fulfillmentId = fulfillments[0]?.id
  if (!fulfillmentId) return

  try {
    await markOrderFulfillmentAsDeliveredWorkflow(scope as any).run({
      input: {
        orderId,
        fulfillmentId,
        no_notification: true,
      } as any,
    })
  } catch (e) {
    console.error('[order-status-transition] markOrderFulfillmentAsDeliveredWorkflow error (non-fatal):', e)
  }
}
