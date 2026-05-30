/**
 * GET  /store/sellers/me/orders/:id  — full order detail for the seller
 * PATCH /store/sellers/me/orders/:id — update order (fulfill / ship / mark delivered)
 *
 * Body for PATCH: { status: 'processing' | 'shipped' | 'delivered' }
 *   - 'processing' → no-op in Medusa (just acknowledged)
 *   - 'shipped'    → creates a Fulfillment record with optional tracking data
 *   - 'delivered'  → marks fulfillment as delivered (if supported)
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { normalizeMedusaOrder } from '../route'
import { resolveSeller } from '../../../../_utils/clerk-auth'

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
//
// Advances the order lifecycle. We persist the shipment + lifecycle state on the
// Medusa order itself (the system of record) via order.metadata, rather than the
// Fulfillment module: our checkout prices/handles shipping through Envia (stored
// in metadata) and never attaches a Medusa shipping method, so the Fulfillment
// workflows — which derive provider/profile/location from the order's shipping
// option — can't run. Keeping shipment state on the order means the buyer detail
// page, seller views, and autoconfirm all read one source. normalizeMedusaOrder
// surfaces metadata.shipment + metadata.fulfillment_state.

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
      relations: ['items'],
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
