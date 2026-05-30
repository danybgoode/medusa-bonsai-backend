/**
 * GET  /store/sellers/me/orders/:id  — full order detail for the seller
 * PATCH /store/sellers/me/orders/:id — update order (fulfill / ship / mark delivered)
 *
 * Body for PATCH: { status: 'processing' | 'shipped' | 'delivered' }
 *   - 'processing' → acknowledged in metadata
 *   - 'shipped'    → createOrderFulfillmentWorkflow + createOrderShipmentWorkflow (E-full)
 *                    + metadata.shipment (E-lite fallback, always written for normalizeMedusaOrder)
 *   - 'delivered'  → markOrderFulfillmentAsDeliveredWorkflow + metadata.delivered_at
 *   - 'completed'  → metadata only (completeOrderWorkflow deferred — returns still pend)
 *
 * E-full: workflows run when shipping options are seeded (POST /internal/setup-fulfillment).
 * If the option IDs aren't found the route falls back gracefully to metadata-only (E-lite).
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import {
  createOrderFulfillmentWorkflow,
  createOrderShipmentWorkflow,
  markOrderFulfillmentAsDeliveredWorkflow,
} from '@medusajs/medusa/core-flows'
import { normalizeMedusaOrder } from '../route'
import { resolveSeller } from '../../../../_utils/clerk-auth'
import { resolveShippingOptionIds, resolveStockLocationId } from '../../../../_utils/fulfillment'

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const seller = await resolveSeller(req)
  if (!seller) return res.status(401).json({ message: 'Unauthorized' })

  const { id: orderId } = req.params
  const orderService = req.scope.resolve(Modules.ORDER) as any

  let order: Record<string, unknown>
  try {
    const result = await orderService.retrieveOrder(orderId, {
      select: [
        'id', 'status', 'payment_status', 'fulfillment_status',
        'total', 'subtotal', 'currency_code',
        'email', 'metadata', 'created_at', 'updated_at',
      ],
      relations: ['items', 'shipping_address', 'customer', 'fulfillments', 'payments'],
    })
    if (!result) return res.status(404).json({ message: 'Order not found' })
    order = result as Record<string, unknown>
  } catch {
    return res.status(404).json({ message: 'Order not found' })
  }

  // Verify the order contains one of this seller's products (security check)
  const remoteQuery = req.scope.resolve(ContainerRegistrationKeys.REMOTE_QUERY)
  let productIds: string[] = []
  try {
    const { data: sellerRows } = await (remoteQuery as any).graph({
      entity: 'seller',
      fields: ['id', 'products.id'],
      filters: { id: seller.sellerId },
    })
    productIds = ((sellerRows?.[0] as any)?.products ?? []).map((p: any) => p.id as string)
  } catch { /* skip security check if link query fails */ }

  if (productIds.length > 0) {
    const orderProductIds = ((order.items as any[]) ?? []).map((i: any) => i.product_id)
    const hasSellerProduct = orderProductIds.some((id: string) => productIds.includes(id))
    if (!hasSellerProduct) {
      return res.status(403).json({ message: 'Forbidden' })
    }
  }

  return res.json({ order: normalizeMedusaOrder(order, seller.sellerId, seller.sellerName) })
}

// ── PATCH ─────────────────────────────────────────────────────────────────────

const LIFECYCLE_STATES = new Set(['processing', 'shipped', 'in_transit', 'delivered', 'completed'])

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const seller = await resolveSeller(req)
  if (!seller) return res.status(401).json({ message: 'Unauthorized' })

  const { id: orderId } = req.params
  const body = req.body as {
    status?: string
    carrier?: string
    carrier_label?: string
    tracking_number?: string
  }

  const newStatus = body.status
  if (!newStatus) return res.status(400).json({ message: 'status is required' })
  if (!LIFECYCLE_STATES.has(newStatus)) {
    return res.status(422).json({ message: `Unsupported status transition: ${newStatus}` })
  }

  const orderService = req.scope.resolve(Modules.ORDER) as any
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  let order: Record<string, unknown>
  try {
    order = await orderService.retrieveOrder(orderId, {
      select: ['id', 'metadata'],
      relations: ['items', 'fulfillments'],
    })
  } catch {
    return res.status(404).json({ message: 'Order not found' })
  }

  // Ownership: the order must contain one of this seller's products.
  try {
    const { data: sellerRows } = await query.graph({
      entity: 'seller',
      fields: ['id', 'products.id'],
      filters: { id: seller.sellerId },
    })
    const productIds: string[] = ((sellerRows?.[0] as any)?.products ?? []).map((p: any) => p.id)
    if (productIds.length > 0) {
      const orderProductIds = ((order.items as any[]) ?? []).map((i: any) => i.product_id)
      if (!orderProductIds.some((id: string) => productIds.includes(id))) {
        return res.status(403).json({ message: 'Forbidden' })
      }
    }
  } catch { /* if the link query fails, skip the check rather than block shipping */ }

  const meta = ((order.metadata ?? {}) as Record<string, any>)
  const prevShipment = (meta.shipment ?? {}) as Record<string, any>
  const now = new Date().toISOString()

  let fulfillmentState = newStatus
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

  // ── E-full: native Medusa fulfillment workflows ──────────────────────────
  // Run alongside the metadata update (which drives normalizeMedusaOrder).
  // Falls back gracefully if shipping options aren't seeded yet.

  if (newStatus === 'shipped' || newStatus === 'in_transit') {
    await runFulfillWorkflow({ req, order, orderId, body, newStatus, now })
  } else if (newStatus === 'delivered') {
    await runDeliveredWorkflow({ req, order, orderId })
  }

  // ── Always: persist lifecycle state on order.metadata ────────────────────
  try {
    await orderService.updateOrders(orderId, {
      metadata: {
        ...meta,
        fulfillment_state: fulfillmentState,
        ...(Object.keys(shipment).length ? { shipment } : {}),
        ...(newStatus === 'delivered' ? { delivered_at: now } : {}),
        ...(newStatus === 'completed' ? { completed_at: now } : {}),
      },
    })
  } catch (e) {
    console.error('[seller orders] status update error:', e)
    return res.status(500).json({ message: 'Failed to update order' })
  }

  return res.json({ status: newStatus })
}

// ── E-full helpers ────────────────────────────────────────────────────────────

async function runFulfillWorkflow({
  req,
  order,
  orderId,
  body,
  newStatus,
  now,
}: {
  req: MedusaRequest
  order: Record<string, unknown>
  orderId: string
  body: { carrier?: string; tracking_number?: string }
  newStatus: string
  now: string
}) {
  const fulfillments = (order.fulfillments as any[]) ?? []
  const existingFulfillment = fulfillments[0]

  // If already has a native fulfillment, just add the shipment label
  if (existingFulfillment?.id) {
    await runShipmentWorkflow({ req, orderId, fulfillmentId: existingFulfillment.id, order, body })
    return
  }

  // Resolve shipping option for this order's fulfillment method
  const meta = (order.metadata ?? {}) as Record<string, any>
  const fulfillmentMethod = (meta.fulfillment_method ?? 'shipping') as string
  const optionKey = fulfillmentMethod === 'local_pickup' ? 'pickup'
    : fulfillmentMethod === 'digital' || fulfillmentMethod === 'service' ? 'digital'
    : 'shipping'

  const [optionIds, locationId] = await Promise.all([
    resolveShippingOptionIds(req.scope),
    resolveStockLocationId(req.scope),
  ])

  const shippingOptionId = optionIds[optionKey]
  if (!shippingOptionId) {
    // Shipping options not seeded yet — E-lite metadata path continues
    console.warn('[seller orders] E-full skipped: shipping option not found, option_key=%s', optionKey)
    return
  }

  const items = ((order.items as any[]) ?? []).map((i: any) => ({ id: i.id, quantity: i.quantity ?? 1 }))
  if (!items.length) return

  try {
    const { result: fulfillment } = await createOrderFulfillmentWorkflow(req.scope).run({
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
      await runShipmentWorkflow({ req, orderId, fulfillmentId: (fulfillment as any).id, order, body })
    }
  } catch (e) {
    // E-full failures are non-fatal — metadata update still runs
    console.error('[seller orders] createOrderFulfillmentWorkflow error (non-fatal):', e)
  }
}

async function runShipmentWorkflow({
  req,
  orderId,
  fulfillmentId,
  order,
  body,
}: {
  req: MedusaRequest
  orderId: string
  fulfillmentId: string
  order: Record<string, unknown>
  body: { carrier?: string; tracking_number?: string }
}) {
  if (!body.tracking_number) return

  const items = ((order.items as any[]) ?? []).map((i: any) => ({ id: i.id, quantity: i.quantity ?? 1 }))
  if (!items.length) return

  try {
    await createOrderShipmentWorkflow(req.scope).run({
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
    console.error('[seller orders] createOrderShipmentWorkflow error (non-fatal):', e)
  }
}

async function runDeliveredWorkflow({
  req,
  order,
  orderId,
}: {
  req: MedusaRequest
  order: Record<string, unknown>
  orderId: string
}) {
  const fulfillments = (order.fulfillments as any[]) ?? []
  const fulfillmentId = fulfillments[0]?.id
  if (!fulfillmentId) return

  try {
    await markOrderFulfillmentAsDeliveredWorkflow(req.scope).run({
      input: {
        orderId,
        fulfillmentId,
        no_notification: true,
      } as any,
    })
  } catch (e) {
    console.error('[seller orders] markOrderFulfillmentAsDeliveredWorkflow error (non-fatal):', e)
  }
}
