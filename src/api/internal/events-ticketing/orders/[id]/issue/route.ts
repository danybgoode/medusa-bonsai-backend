/**
 * POST /internal/events-ticketing/orders/:id/issue
 *
 * Mints paid event-ticket tokens — one PER UNIT (`line_item.quantity`) — into
 * order.metadata.event_tickets. Line-item metadata carries the "event admission"
 * stamp; order metadata makes the seller roster + door lookup cheap and durable.
 *
 * Idempotent: re-called by the reconcile-checkouts cron AND both payment
 * webhooks, so the per-unit dedupe (in `reconcileOrderTickets`) keys on the
 * per-unit subject — a replay of an N-quantity order yields exactly N, no dupes.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import {
  EVENT_TICKETS_METADATA_KEY,
  readTickets,
  reconcileOrderTickets,
  unauthorized,
} from '../../../_utils'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { id: orderId } = req.params
  const orderService = req.scope.resolve(Modules.ORDER) as any

  let order: Record<string, any>
  try {
    order = await orderService.retrieveOrder(orderId, {
      select: ['id', 'email', 'metadata'],
      relations: ['items'],
    })
  } catch {
    return res.status(404).json({ message: 'Order not found' })
  }

  const meta = (order.metadata ?? {}) as Record<string, unknown>
  const now = new Date().toISOString()

  const tickets = reconcileOrderTickets({
    items: ((order.items ?? []) as Record<string, any>[]).map(item => ({
      id: String(item.id),
      quantity: item.quantity,
      product_id: item.product_id,
      metadata: item.metadata,
    })),
    existing: readTickets(meta[EVENT_TICKETS_METADATA_KEY]),
    orderId,
    buyerEmail: typeof order.email === 'string' ? order.email : null,
    now,
  })

  // No event line items and no pre-existing tickets — nothing to persist.
  if (!tickets.length) return res.json({ tickets: [] })

  await orderService.updateOrders(orderId, {
    metadata: {
      ...meta,
      [EVENT_TICKETS_METADATA_KEY]: tickets,
      event_ticket_issued_at: (meta.event_ticket_issued_at as string | undefined) ?? now,
    },
  })

  return res.json({ tickets })
}
