/**
 * POST /internal/events-ticketing/orders/:id/issue
 *
 * Copies paid event-ticket tokens from order line-item metadata into
 * order.metadata.event_tickets. Line-item metadata remains the attendee-level
 * source; order metadata makes seller roster + door lookup cheap and durable.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import {
  EVENT_TICKET_METADATA_KEY,
  EVENT_TICKETS_METADATA_KEY,
  mintTicketToken,
  readTicket,
  readTickets,
  type EventTicket,
  unauthorized,
} from '../../../_utils'

function ticketFromLineItem(input: {
  item: Record<string, any>
  orderId: string
  buyerEmail: string | null
  now: string
}): EventTicket | null {
  const meta = (input.item.metadata ?? {}) as Record<string, unknown>
  const existing = readTicket(meta[EVENT_TICKET_METADATA_KEY])
  if (!existing && !meta[EVENT_TICKET_METADATA_KEY]) return null

  return {
    version: 1,
    token: existing?.token ?? mintTicketToken(),
    source: 'paid',
    state: existing?.state ?? 'issued',
    issued_at: existing?.issued_at ?? input.now,
    subject_id: String(input.item.id),
    event_id: existing?.event_id ?? null,
    product_id: existing?.product_id ?? String(input.item.product_id ?? ''),
    order_id: input.orderId,
    line_item_id: String(input.item.id),
    attendee_name: existing?.attendee_name ?? null,
    attendee_email: existing?.attendee_email ?? input.buyerEmail,
    redeemed_at: existing?.redeemed_at ?? null,
    redeemed_by: existing?.redeemed_by ?? null,
  }
}

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
  const existingTickets = readTickets(meta[EVENT_TICKETS_METADATA_KEY])
  const now = new Date().toISOString()
  const itemTickets = ((order.items ?? []) as Record<string, any>[])
    .map(item => ticketFromLineItem({
      item,
      orderId,
      buyerEmail: typeof order.email === 'string' ? order.email : null,
      now,
    }))
    .filter((ticket): ticket is EventTicket => !!ticket)

  if (!itemTickets.length && !existingTickets.length) return res.json({ tickets: [] })

  const byToken = new Map<string, EventTicket>()
  for (const ticket of existingTickets) byToken.set(ticket.token, ticket)
  for (const ticket of itemTickets) {
    const existing = existingTickets.find(t => t.line_item_id === ticket.line_item_id || t.token === ticket.token)
    byToken.set(ticket.token, existing ?? ticket)
  }

  const tickets = [...byToken.values()]
  await orderService.updateOrders(orderId, {
    metadata: {
      ...meta,
      [EVENT_TICKETS_METADATA_KEY]: tickets,
      event_ticket_issued_at: (meta.event_ticket_issued_at as string | undefined) ?? now,
    },
  })

  return res.json({ tickets })
}
