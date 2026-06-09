/**
 * POST /internal/events-ticketing/redeem
 *
 * Door-scan mutation for paid tickets. The token lookup is seller-scoped and
 * the metadata update is conditional on state=issued, so a second scan cannot
 * write another redeemed transition.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import {
  EVENT_TICKETS_METADATA_KEY,
  isTicketToken,
  readTickets,
  redeemTicket,
  type EventTicket,
  unauthorized,
} from '../_utils'

async function sellerProductIds(req: MedusaRequest, sellerId: string): Promise<Set<string>> {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await (query as any).graph({
    entity: 'seller',
    fields: ['id', 'products.id'],
    filters: { id: sellerId },
  })
  return new Set(((data?.[0] as any)?.products ?? []).map((p: any) => p.id as string))
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const body = (req.body ?? {}) as {
    token?: string
    sellerId?: string
    redeemedBy?: string
  }
  const token = body.token?.trim()
  if (!isTicketToken(token) || !body.sellerId) {
    return res.status(404).json({ status: 'not_found' })
  }

  const knex = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
  const lookup = await knex.raw(
    `select id, metadata
       from "order"
      where metadata->? @> ?::jsonb
        and deleted_at is null
      limit 1`,
    [EVENT_TICKETS_METADATA_KEY, JSON.stringify([{ token }])],
  )
  const order = (lookup?.rows ?? [])[0] as { id: string; metadata: Record<string, unknown> | null } | undefined
  if (!order) return res.status(404).json({ status: 'not_found' })

  const meta = (order.metadata ?? {}) as Record<string, unknown>
  const tickets = readTickets(meta[EVENT_TICKETS_METADATA_KEY])
  const current = tickets.find(ticket => ticket.token === token)
  if (!current) return res.status(404).json({ status: 'not_found' })

  const productIds = await sellerProductIds(req, body.sellerId)
  if (!current.product_id || !productIds.has(current.product_id)) {
    return res.status(403).json({ status: 'wrong_seller', ticket: current })
  }

  const redeemed = redeemTicket(current, { redeemedBy: body.redeemedBy ?? body.sellerId })
  if (!redeemed) {
    return res.status(409).json({ status: 'already_used', ticket: current })
  }

  const nextTickets: EventTicket[] = tickets.map(ticket => ticket.token === token ? redeemed : ticket)
  const nextMeta = {
    ...meta,
    [EVENT_TICKETS_METADATA_KEY]: nextTickets,
  }

  const changed = await knex('order')
    .where({ id: order.id })
    .whereRaw(`metadata->? @> ?::jsonb`, [
      EVENT_TICKETS_METADATA_KEY,
      JSON.stringify([{ token, state: 'issued' }]),
    ])
    .update({ metadata: JSON.stringify(nextMeta) })

  if (!changed) return res.status(409).json({ status: 'already_used', ticket: current })

  return res.json({ status: 'valid', ticket: redeemed })
}
