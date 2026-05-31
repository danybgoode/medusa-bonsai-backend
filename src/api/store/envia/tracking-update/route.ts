/**
 * POST /store/envia/tracking-update
 *
 * Internal endpoint called by the Next.js Envia webhook handler after
 * signature verification. Updates the Medusa order's fulfillment state
 * and shipment metadata when Envia fires a tracking status event.
 *
 * Only processes Medusa orders (orderId must start with "order_").
 * Legacy Supabase orders are handled directly in the Next.js webhook.
 *
 * Security: only called server-to-server from Next.js (behind the Envia
 * HMAC verification step). Additionally protected by MEDUSA_INTERNAL_SECRET
 * (x-internal-secret header) — same pattern used by all internal endpoints.
 *
 * Body: {
 *   orderId:        string   — Medusa order ID (starts with "order_")
 *   enviaStatus:    string   — normalised Envia status (e.g. "delivered")
 *   trackingNumber: string?  — carrier tracking number (may update the record)
 *   enviaShipmentId: string? — Envia shipment ID (for logging)
 * }
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { markOrderFulfillmentAsDeliveredWorkflow } from '@medusajs/medusa/core-flows'

// Envia status → our fulfillment_state (only advance, never retreat)
const ENVIA_TO_FULFILLMENT_STATE: Record<string, string> = {
  label_created:    'shipped',
  picked_up:        'in_transit',
  in_transit:       'in_transit',
  out_for_delivery: 'in_transit',
  delivered:        'delivered',
  // exception / cancelled → stay at current state (handled below)
}

// Rank used to ensure we only advance state, never go backwards
const STATE_RANK: Record<string, number> = {
  pending: 0, paid: 1, processing: 2,
  shipped: 3, in_transit: 4, delivered: 5, completed: 6,
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  // Internal secret guard — matches the pattern used by all /internal/* routes
  const internalSecret = process.env.MEDUSA_INTERNAL_SECRET
  if (internalSecret) {
    const provided = req.headers['x-internal-secret'] as string | undefined
    if (provided !== internalSecret) {
      return res.status(401).json({ message: 'Unauthorized' })
    }
  }

  const body = req.body as {
    orderId?: string
    enviaStatus?: string
    trackingNumber?: string
    enviaShipmentId?: string
  }

  const { orderId, enviaStatus, trackingNumber, enviaShipmentId } = body

  if (!orderId?.startsWith('order_')) {
    return res.status(400).json({ message: 'orderId must be a Medusa order ID (order_*)' })
  }
  if (!enviaStatus) {
    return res.status(400).json({ message: 'enviaStatus is required' })
  }

  const orderService = req.scope.resolve(Modules.ORDER) as any
  let order: Record<string, unknown>
  try {
    order = await orderService.retrieveOrder(orderId, {
      select: ['id', 'metadata'],
      relations: ['fulfillments'],
    })
  } catch {
    return res.status(404).json({ message: 'Order not found' })
  }

  const meta = ((order.metadata ?? {}) as Record<string, any>)
  const prevShipment = (meta.shipment ?? {}) as Record<string, any>
  const currentState = (meta.fulfillment_state ?? meta.status ?? 'shipped') as string
  const currentRank  = STATE_RANK[currentState] ?? 3   // default to shipped rank

  // Map Envia status → our fulfillment state
  const newFulfillmentState = ENVIA_TO_FULFILLMENT_STATE[enviaStatus]

  // Compute the new shipment status (always record it, regardless of rank)
  const updatedShipment = {
    ...prevShipment,
    status: enviaStatus,
    ...(trackingNumber ? { tracking_number: trackingNumber } : {}),
    ...(enviaShipmentId ? { envia_shipment_id: enviaShipmentId } : {}),
    ...(enviaStatus === 'delivered' ? { delivered_at: new Date().toISOString() } : {}),
  }

  // Only advance fulfillment_state — never retreat
  const shouldAdvance = newFulfillmentState &&
    (STATE_RANK[newFulfillmentState] ?? 0) > currentRank

  const newMeta = {
    ...meta,
    shipment: updatedShipment,
    ...(shouldAdvance ? { fulfillment_state: newFulfillmentState } : {}),
    ...(enviaStatus === 'delivered' ? { delivered_at: new Date().toISOString() } : {}),
  }

  try {
    await orderService.updateOrders(orderId, { metadata: newMeta })
  } catch (e) {
    console.error('[envia/tracking-update] metadata update failed:', e)
    return res.status(500).json({ message: 'Failed to update order metadata' })
  }

  // Run delivered workflow when transitioning to delivered
  if (enviaStatus === 'delivered' && shouldAdvance) {
    const fulfillments = (order.fulfillments as any[]) ?? []
    const fulfillmentId = fulfillments[0]?.id

    if (fulfillmentId) {
      try {
        await markOrderFulfillmentAsDeliveredWorkflow(req.scope).run({
          input: {
            orderId,
            fulfillmentId,
            no_notification: true,
          } as any,
        })
        console.log(`[envia/tracking-update] ${orderId} marked delivered via workflow`)
      } catch (e) {
        // Non-fatal: metadata already updated, workflow is a best-effort bonus
        console.error('[envia/tracking-update] markOrderFulfillmentAsDeliveredWorkflow error (non-fatal):', e)
      }
    }
  }

  console.log(
    `[envia/tracking-update] ${orderId} | ${enviaStatus}` +
    `${shouldAdvance ? ` → ${newFulfillmentState}` : ' (no state change)'}` +
    (trackingNumber ? ` | tracking: ${trackingNumber}` : '')
  )

  return res.json({
    updated: true,
    orderId,
    enviaStatus,
    fulfillmentState: shouldAdvance ? newFulfillmentState : currentState,
  })
}
