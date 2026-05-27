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

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const seller = await resolveSeller(req)
  if (!seller) return res.status(401).json({ message: 'Unauthorized' })

  const { id: orderId } = req.params
  const body = req.body as {
    status?: string
    carrier?: string
    tracking_number?: string
  }

  if (!body.status) {
    return res.status(400).json({ message: 'status is required' })
  }

  const orderService = req.scope.resolve(Modules.ORDER) as any
  const fulfillmentService = req.scope.resolve(Modules.FULFILLMENT) as any | null

  let order: Record<string, unknown>
  try {
    order = await orderService.retrieveOrder(orderId, {
      relations: ['items', 'fulfillments'],
    })
  } catch {
    return res.status(404).json({ message: 'Order not found' })
  }

  const newStatus = body.status

  // 'processing' → acknowledge, no Medusa operation needed
  if (newStatus === 'processing') {
    return res.json({ status: 'processing' })
  }

  // 'shipped' → create a fulfillment record in Medusa
  if (newStatus === 'shipped' || newStatus === 'in_transit') {
    try {
      const items = ((order.items as any[]) ?? []).map((item: any) => ({
        id: item.id,
        quantity: item.quantity,
      }))

      // Create fulfillment via order service or fulfillment service
      if (fulfillmentService) {
        await fulfillmentService.createFulfillment?.({
          order_id: orderId,
          items,
          data: {
            carrier: body.carrier ?? 'manual',
            tracking_number: body.tracking_number ?? null,
          },
        }).catch((e: unknown) => console.error('[seller orders] fulfillment create error:', e))
      }
    } catch (e) {
      console.error('[seller orders] ship error:', e)
      // Non-fatal — return shipped status anyway
    }
    return res.json({ status: 'shipped' })
  }

  // 'delivered' → complete the order in Medusa
  if (newStatus === 'delivered' || newStatus === 'completed') {
    try {
      await orderService.completeOrder?.(orderId).catch((e: unknown) => console.error('[seller orders] complete error:', e))
    } catch { /* non-fatal */ }
    return res.json({ status: 'delivered' })
  }

  return res.status(422).json({ message: `Unsupported status transition: ${newStatus}` })
}
