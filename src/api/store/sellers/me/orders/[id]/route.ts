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
import { normalizeMedusaOrder } from '../route'
import { resolveSeller } from '../../../../_utils/clerk-auth'
import { applyOrderStatusTransition, LIFECYCLE_STATES } from '../../../../../../lib/order-status-transition'

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const seller = await resolveSeller(req)
  if (!seller) return res.status(401).json({ message: 'Unauthorized' })

  const { id: orderId } = req.params

  // Fetch via query.graph — orderService.retrieveOrder throws "Shipping method
  // version is required to load adjustments" once an order has a shipping method,
  // which the catch turned into a 404 (seller order detail page was unreachable).
  let order: Record<string, unknown>
  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await (query as any).graph({
      entity: 'order',
      fields: [
        'id', 'status', 'payment_status', 'fulfillment_status',
        'total', 'subtotal', 'currency_code',
        'email', 'metadata', 'created_at', 'updated_at',
        'items.*', 'shipping_address.*', 'customer.*', 'fulfillments.*',
      ],
      filters: { id: orderId },
    })
    const result = (data ?? [])[0]
    if (!result) return res.status(404).json({ message: 'Order not found' })
    order = result as Record<string, unknown>
  } catch (e) {
    console.error('[seller/me/orders/:id] order query error:', e)
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

  const result = await applyOrderStatusTransition(req.scope, {
    orderId,
    order,
    newStatus,
    body: { carrier: body.carrier, carrier_label: body.carrier_label, tracking_number: body.tracking_number },
  })
  if (!result.ok) return res.status(result.status).json({ message: result.message })

  return res.json({ status: newStatus })
}
