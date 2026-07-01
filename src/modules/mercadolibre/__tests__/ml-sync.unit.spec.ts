import {
  clampAvailable,
  safeDecrement,
  shouldPushStock,
  isOrderApplied,
  recordAppliedOrder,
  isSoldOrderStatus,
  APPLIED_ORDERS_CAP,
  type AppliedOrder,
} from '../sync-utils'
import { normalizeOrderItems } from '../client'

/**
 * Mercado Libre module · Sprint 4 pure stock-sync helpers (the deterministic
 * backend gate). No DB, no network. Proves the oversell-safe **delta** model:
 * a sale decrements Medusa by exactly the sold qty (never negative — US-11),
 * exactly-once per ML order id (US-11/12), the outbound mirror idempotency
 * (US-10), and the order → per-item quantity aggregation.
 */

describe('clampAvailable', () => {
  it('floors to a non-negative integer; null/NaN/negative → 0', () => {
    expect(clampAvailable(5)).toBe(5)
    expect(clampAvailable(-3)).toBe(0)
    expect(clampAvailable(2.9)).toBe(2)
    expect(clampAvailable(null)).toBe(0)
    expect(clampAvailable(Number.NaN)).toBe(0)
    expect(clampAvailable(Infinity)).toBe(0)
  })
})

describe('safeDecrement — the relative, reservation-safe decrement (no oversell)', () => {
  it('removes the sold quantity from available (stocked − reserved)', () => {
    expect(safeDecrement(5, 0, 2)).toBe(2) // available 5, sell 2 → remove 2
    expect(safeDecrement(5, 1, 2)).toBe(2) // available 4, sell 2 → remove 2 (reservation preserved)
  })
  it('caps the decrement at available so available never goes negative / reservations are honored', () => {
    expect(safeDecrement(5, 1, 6)).toBe(4) // available 4, sell 6 → remove only 4 (leaves reserved intact)
    expect(safeDecrement(3, 3, 2)).toBe(0) // available 0 (all reserved) → remove nothing
    expect(safeDecrement(0, 0, 1)).toBe(0)
  })
  it('INVARIANT: over a grid, 0 ≤ decrement ≤ available and ≤ soldQty (never over-removes)', () => {
    for (let s = -2; s <= 12; s++) {
      for (let r = -2; r <= 12; r++) {
        for (let q = -2; q <= 12; q++) {
          const d = safeDecrement(s, r, q)
          const available = Math.max(0, clampAvailable(s) - clampAvailable(r))
          expect(d).toBeGreaterThanOrEqual(0)
          expect(d).toBeLessThanOrEqual(available)
          expect(d).toBeLessThanOrEqual(clampAvailable(q))
        }
      }
    }
  })
})

describe('isSoldOrderStatus — only a paid order consumes stock', () => {
  it('paid → true; everything else → false', () => {
    expect(isSoldOrderStatus('paid')).toBe(true)
    expect(isSoldOrderStatus('payment_required')).toBe(false)
    expect(isSoldOrderStatus('cancelled')).toBe(false)
    expect(isSoldOrderStatus('confirmed')).toBe(false)
    expect(isSoldOrderStatus(null)).toBe(false)
    expect(isSoldOrderStatus(undefined)).toBe(false)
  })
})

describe('shouldPushStock — outbound mirror idempotency (US-10)', () => {
  it('never pushed → push; unchanged → skip; changed → push', () => {
    expect(shouldPushStock({ currentAvailable: 4 })).toBe(true)
    expect(shouldPushStock({ currentAvailable: 4, lastPushedAvailable: 4 })).toBe(false)
    expect(shouldPushStock({ currentAvailable: 3, lastPushedAvailable: 4 })).toBe(true)
  })
})

describe('applied-order ring — exactly-once per ML order id (US-11/12)', () => {
  const now = '2026-06-30T00:00:00.000Z'

  it('a re-seen order id is detected as applied → no double-decrement', () => {
    const ring: AppliedOrder[] = [{ id: 'ord_1', ts: now }]
    expect(isOrderApplied(ring, 'ord_1')).toBe(true)
    expect(isOrderApplied(ring, 'ord_2')).toBe(false)
    expect(isOrderApplied(null, 'ord_1')).toBe(false)
    expect(isOrderApplied(ring, '')).toBe(false)
  })

  it('recording appends new ids, ignores duplicates/blanks, and stays bounded', () => {
    let ring = recordAppliedOrder(null, 'ord_1', now)
    expect(ring).toEqual([{ id: 'ord_1', ts: now }])
    expect(recordAppliedOrder(ring, 'ord_1', now)).toBe(ring) // duplicate → unchanged ref
    expect(recordAppliedOrder(ring, '', now)).toBe(ring)
    for (let i = 0; i < APPLIED_ORDERS_CAP + 10; i++) ring = recordAppliedOrder(ring, `o_${i}`, now)
    expect(ring.length).toBe(APPLIED_ORDERS_CAP)
    expect(isOrderApplied(ring, `o_${APPLIED_ORDERS_CAP + 9}`)).toBe(true) // latest still remembered
  })
})

describe('normalizeOrderItems — per-item sold quantities', () => {
  it('sums quantities per ML item and drops items without an id', () => {
    const items = normalizeOrderItems({
      id: 'ord_9',
      order_items: [
        { item: { id: 'MLM1' }, quantity: 2 },
        { item: { id: 'MLM1' }, quantity: 1 }, // same item, second line → summed
        { item: { id: 'MLM2' }, quantity: 3 },
        { item: {}, quantity: 5 }, // no id → dropped
      ],
    })
    expect(items).toEqual([
      { mlItemId: 'MLM1', quantity: 3 },
      { mlItemId: 'MLM2', quantity: 3 },
    ])
  })
  it('degrades a missing/odd quantity to 0 (no throw)', () => {
    expect(normalizeOrderItems({ id: 'o', order_items: [{ item: { id: 'X' } }] })).toEqual([
      { mlItemId: 'X', quantity: 0 },
    ])
    expect(normalizeOrderItems({ id: 'o' })).toEqual([])
  })
})
