import { randomBytes } from 'crypto'

export const EVENT_TICKET_METADATA_KEY = 'event_ticket'
export const EVENT_TICKETS_METADATA_KEY = 'event_tickets'

export type EventTicketState = 'issued' | 'redeemed'

export type EventTicket = {
  version: 1
  token: string
  source: 'paid' | 'free'
  state: EventTicketState
  issued_at: string
  subject_id: string
  event_id?: string | null
  product_id?: string | null
  order_id?: string | null
  line_item_id?: string | null
  attendee_name?: string | null
  attendee_email?: string | null
  redeemed_at?: string | null
  redeemed_by?: string | null
}

export function unauthorized(req: { headers: Record<string, unknown> }): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !!expected && got !== expected
}

export function mintTicketToken(): string {
  return `tkt_${randomBytes(24).toString('hex')}`
}

export function isTicketToken(value: unknown): value is string {
  return typeof value === 'string' && /^tkt_[a-f0-9]{32,}$/i.test(value)
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

export function readTicket(value: unknown): EventTicket | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const token = cleanString(raw.token)
  const source = raw.source === 'paid' || raw.source === 'free' ? raw.source : null
  const state = raw.state === 'issued' || raw.state === 'redeemed' ? raw.state : null
  const issuedAt = cleanString(raw.issued_at)
  const subjectId = cleanString(raw.subject_id)
  if (!isTicketToken(token) || !source || !state || !issuedAt || !subjectId) return null
  return {
    version: 1,
    token,
    source,
    state,
    issued_at: issuedAt,
    subject_id: subjectId,
    event_id: cleanString(raw.event_id),
    product_id: cleanString(raw.product_id),
    order_id: cleanString(raw.order_id),
    line_item_id: cleanString(raw.line_item_id),
    attendee_name: cleanString(raw.attendee_name),
    attendee_email: cleanString(raw.attendee_email),
    redeemed_at: cleanString(raw.redeemed_at),
    redeemed_by: cleanString(raw.redeemed_by),
  }
}

export function readTickets(value: unknown): EventTicket[] {
  if (!Array.isArray(value)) return []
  return value.map(readTicket).filter((ticket): ticket is EventTicket => !!ticket)
}

export function redeemTicket(ticket: EventTicket, input: {
  now?: string
  redeemedBy?: string | null
}): EventTicket | null {
  if (ticket.state !== 'issued') return null
  return {
    ...ticket,
    state: 'redeemed',
    redeemed_at: input.now ?? new Date().toISOString(),
    redeemed_by: input.redeemedBy ?? null,
  }
}
