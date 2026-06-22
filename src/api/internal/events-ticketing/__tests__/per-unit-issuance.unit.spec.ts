import {
  EVENT_TICKET_METADATA_KEY,
  reconcileOrderTickets,
  unitSubjectId,
  type EventTicket,
} from '../_utils'

/**
 * S1.1 — per-unit event-ticket issuance, idempotent on the per-unit subject.
 *
 * The backend used to mint one token per LINE ITEM and ignore `quantity`, so
 * buying N charged for N but issued 1. `reconcileOrderTickets` now mints one
 * token per UNIT and dedupes on `${line_item_id}#${k}` so a replay (the
 * reconcile cron + both payment webhooks all re-call `issue`) yields exactly N.
 */

// A deterministic, unique token factory so assertions are stable.
function makeMint() {
  let n = 0
  return () => `tkt_${String(n++).padStart(2, '0').repeat(24)}` // tkt_ + 48 hex-safe chars
}

const STAMP_TOKEN = `tkt_${'a'.repeat(48)}`

/** The single `event_ticket` line-item stamp written by lib/cart.ts at add-time. */
function stamp(productId = 'prod_evt'): EventTicket {
  return {
    version: 1,
    token: STAMP_TOKEN,
    source: 'paid',
    state: 'issued',
    issued_at: '2026-06-01T00:00:00.000Z',
    subject_id: `cart:${productId}:123`,
    event_id: null,
    product_id: productId,
    order_id: null,
    line_item_id: null,
    attendee_name: null,
    attendee_email: null,
    redeemed_at: null,
    redeemed_by: null,
  }
}

function eventLineItem(id: string, quantity: number, productId = 'prod_evt') {
  return {
    id,
    quantity,
    product_id: productId,
    metadata: { [EVENT_TICKET_METADATA_KEY]: stamp(productId) },
  }
}

const BASE = {
  orderId: 'order_1',
  buyerEmail: 'buyer@example.com',
  now: '2026-06-22T12:00:00.000Z',
}

describe('reconcileOrderTickets · per-unit issuance', () => {
  it('quantity 1 → exactly 1 token, reusing the stamp token (unchanged vs today)', () => {
    const tickets = reconcileOrderTickets({
      ...BASE,
      items: [eventLineItem('li_1', 1)],
      existing: [],
      mint: makeMint(),
    })

    expect(tickets).toHaveLength(1)
    expect(tickets[0].token).toBe(STAMP_TOKEN)
    expect(tickets[0].subject_id).toBe(unitSubjectId('li_1', 0))
    expect(tickets[0].line_item_id).toBe('li_1')
    expect(tickets[0].attendee_email).toBe('buyer@example.com')
    expect(tickets[0].attendee_name).toBeNull()
    expect(tickets[0].state).toBe('issued')
  })

  it('quantity 3 → exactly 3 distinct tokens, one per unit', () => {
    const tickets = reconcileOrderTickets({
      ...BASE,
      items: [eventLineItem('li_1', 3)],
      existing: [],
      mint: makeMint(),
    })

    expect(tickets).toHaveLength(3)
    const tokens = tickets.map(t => t.token)
    expect(new Set(tokens).size).toBe(3) // all distinct
    expect(tokens[0]).toBe(STAMP_TOKEN) // unit 0 reuses the stamp
    expect(tickets.map(t => t.subject_id)).toEqual([
      unitSubjectId('li_1', 0),
      unitSubjectId('li_1', 1),
      unitSubjectId('li_1', 2),
    ])
    expect(tickets.every(t => t.line_item_id === 'li_1')).toBe(true)
  })

  it('replay (cron/webhook re-call) → still exactly 3, same tokens, no dupes', () => {
    const items = [eventLineItem('li_1', 3)]
    const first = reconcileOrderTickets({ ...BASE, items, existing: [], mint: makeMint() })

    // Re-call with the prior output as `existing` (a fresh mint factory proves
    // no new token is minted — everything matches by per-unit subject).
    const replay = reconcileOrderTickets({ ...BASE, items, existing: first, mint: makeMint() })

    expect(replay).toHaveLength(3)
    expect(replay.map(t => t.token).sort()).toEqual(first.map(t => t.token).sort())
    expect(new Set(replay.map(t => t.token)).size).toBe(3)
  })

  it('replay preserves a redeemed unit (door scan survives re-issue)', () => {
    const items = [eventLineItem('li_1', 3)]
    const first = reconcileOrderTickets({ ...BASE, items, existing: [], mint: makeMint() })
    const redeemed = first.map((t, i) =>
      i === 1 ? { ...t, state: 'redeemed' as const, redeemed_at: BASE.now } : t,
    )

    const replay = reconcileOrderTickets({ ...BASE, items, existing: redeemed, mint: makeMint() })

    expect(replay).toHaveLength(3)
    const stillRedeemed = replay.find(t => t.subject_id === unitSubjectId('li_1', 1))
    expect(stillRedeemed?.state).toBe('redeemed')
    expect(stillRedeemed?.redeemed_at).toBe(BASE.now)
  })

  it('back-compat: a legacy single ticket (subject = line_item_id) replays to 1, no re-mint', () => {
    const legacy: EventTicket = {
      ...stamp(),
      token: STAMP_TOKEN,
      subject_id: 'li_1', // pre-`#k` format
      order_id: 'order_1',
      line_item_id: 'li_1',
      attendee_email: 'buyer@example.com',
    }

    const tickets = reconcileOrderTickets({
      ...BASE,
      items: [eventLineItem('li_1', 1)],
      existing: [legacy],
      mint: makeMint(),
    })

    expect(tickets).toHaveLength(1)
    expect(tickets[0].token).toBe(STAMP_TOKEN) // adopted, not re-minted
    expect(tickets[0].subject_id).toBe(unitSubjectId('li_1', 0)) // migrated
  })

  it('multiple event line items each expand by their own quantity', () => {
    const tickets = reconcileOrderTickets({
      ...BASE,
      items: [eventLineItem('li_1', 2, 'prod_a'), eventLineItem('li_2', 1, 'prod_b')],
      existing: [],
      mint: makeMint(),
    })

    expect(tickets).toHaveLength(3)
    expect(tickets.filter(t => t.line_item_id === 'li_1')).toHaveLength(2)
    expect(tickets.filter(t => t.line_item_id === 'li_2')).toHaveLength(1)
    expect(new Set(tickets.map(t => t.token)).size).toBe(3)
  })

  it('non-event line items issue nothing', () => {
    const tickets = reconcileOrderTickets({
      ...BASE,
      items: [{ id: 'li_x', quantity: 5, product_id: 'prod_mug', metadata: {} }],
      existing: [],
      mint: makeMint(),
    })
    expect(tickets).toHaveLength(0)
  })
})
