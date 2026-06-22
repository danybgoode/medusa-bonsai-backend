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

/** Stable per-unit subject for unit `k` of a line item — the idempotency key. */
export function unitSubjectId(lineItemId: string, k: number): string {
  return `${lineItemId}#${k}`
}

type ReconcileLineItem = {
  id: string
  quantity?: number | null
  product_id?: string | null
  metadata?: Record<string, unknown> | null
}

/**
 * Reconcile order-level event tickets from the order's line items, minting one
 * token PER UNIT (`item.quantity`), idempotent on the per-unit subject.
 *
 * `issue` is re-called by the reconcile-checkouts cron AND both payment webhooks,
 * so the dedupe keys on the per-unit subject (`${line_item_id}#${k}`), NOT the
 * `line_item_id`: all N units of a line item share one `line_item_id`, so keying
 * on it collapses N→1 on replay. A unit already present (matched by subject) is
 * reused verbatim so its `state`/`redeemed_at` survive a replay.
 *
 * Pure + injectable `mint()` for tests.
 */
export function reconcileOrderTickets(input: {
  items: ReconcileLineItem[]
  existing: EventTicket[]
  orderId: string
  buyerEmail: string | null
  now: string
  mint?: () => string
}): EventTicket[] {
  const mint = input.mint ?? mintTicketToken
  const existing = input.existing
  const usedTokens = new Set<string>(existing.map(t => t.token))
  const matchedSubjects = new Set<string>()
  const result: EventTicket[] = []

  for (const item of input.items) {
    const meta = (item.metadata ?? {}) as Record<string, unknown>
    const stamp = readTicket(meta[EVENT_TICKET_METADATA_KEY])
    // The line-item `event_ticket` stamp is the "this is an event admission"
    // marker (it may carry a pre-minted token + event_id/product_id).
    if (!stamp && !meta[EVENT_TICKET_METADATA_KEY]) continue

    const lineItemId = String(item.id)
    const qty = Math.max(1, Math.floor(Number(item.quantity ?? 1)) || 1)

    for (let k = 0; k < qty; k++) {
      const subject = unitSubjectId(lineItemId, k)

      // 1. Idempotent reuse — a ticket already issued at this per-unit subject.
      const bySubject = existing.find(t => t.subject_id === subject)
      if (bySubject) {
        matchedSubjects.add(bySubject.subject_id)
        result.push(bySubject)
        continue
      }

      // 2. Back-compat — pre-`#k` orders stored unit 0 under subject =
      //    line_item_id. Adopt it (reuse the token; migrate the subject) so a
      //    late webhook replay on a pre-deploy order does NOT re-mint.
      if (k === 0) {
        const legacy = existing.find(t => t.subject_id === lineItemId)
        if (legacy) {
          matchedSubjects.add(legacy.subject_id)
          result.push({ ...legacy, subject_id: subject, line_item_id: lineItemId })
          continue
        }
      }

      // 3. Mint a fresh unit. Unit 0 reuses the line-item stamp's token (so a
      //    quantity-1 order is byte-unchanged vs today); units ≥1 mint new.
      let token = k === 0 && stamp && isTicketToken(stamp.token) && !usedTokens.has(stamp.token)
        ? stamp.token
        : mint()
      for (let attempt = 0; usedTokens.has(token) && attempt < 5; attempt++) token = mint()
      if (!isTicketToken(token) || usedTokens.has(token)) {
        throw new Error('Unable to mint a unique event ticket token.')
      }
      usedTokens.add(token)
      matchedSubjects.add(subject)

      result.push({
        version: 1,
        token,
        source: 'paid',
        state: 'issued',
        issued_at: input.now,
        subject_id: subject,
        event_id: stamp?.event_id ?? null,
        product_id: stamp?.product_id ?? (item.product_id != null ? String(item.product_id) : null),
        order_id: input.orderId,
        line_item_id: lineItemId,
        attendee_name: null,
        attendee_email: input.buyerEmail,
        redeemed_at: null,
        redeemed_by: null,
      })
    }
  }

  // Preserve any existing ticket we didn't recompute (e.g. a free RSVP row, or a
  // ticket whose line item is no longer present) — never drop an issued token.
  for (const t of existing) {
    if (!matchedSubjects.has(t.subject_id)) result.push(t)
  }

  return result
}
