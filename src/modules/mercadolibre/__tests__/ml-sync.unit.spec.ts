import {
  clampAvailable,
  safeDecrement,
  shouldPushStock,
  isSoldOrderStatus,
  decideMlOrderApply,
  isUniqueViolationError,
  mapMlOrderStatusToFulfillment,
  shouldApplyFulfillmentTransition,
  isMlCancelledStatus,
  decideMlOrderCancel,
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

describe('decideMlOrderApply — the durable exactly-once + "one inventory effect" decision (US-0)', () => {
  it('a fully-applied row (has a medusa_order_id) always skips, regardless of the flag', () => {
    const existing = { id: 'mlao_1', medusa_order_id: 'order_1' }
    expect(decideMlOrderApply(existing, false)).toEqual({ kind: 'skip' })
    expect(decideMlOrderApply(existing, true)).toEqual({ kind: 'skip' })
  })
  it('no row → apply; order materialization only when the flag is on', () => {
    expect(decideMlOrderApply(null, false)).toEqual({ kind: 'apply', materializeOrder: false })
    expect(decideMlOrderApply(null, true)).toEqual({ kind: 'apply', materializeOrder: true })
    expect(decideMlOrderApply(undefined, true)).toEqual({ kind: 'apply', materializeOrder: true })
  })
  it('stock already applied but materialization never landed (medusa_order_id null) → retry ONLY materialization when the flag is on', () => {
    const stranded = { id: 'mlao_2', medusa_order_id: null }
    expect(decideMlOrderApply(stranded, true)).toEqual({ kind: 'retry-materialize', appliedOrderId: 'mlao_2' })
  })
  it('the same stranded row skips (not retry) when the flag is off — nothing to materialize', () => {
    const stranded = { id: 'mlao_2', medusa_order_id: null }
    expect(decideMlOrderApply(stranded, false)).toEqual({ kind: 'skip' })
  })
})

describe('isUniqueViolationError — defense-in-depth against a lock-service outage race', () => {
  it('recognizes a Postgres 23505 or MikroORM UniqueConstraintViolationException', () => {
    expect(isUniqueViolationError({ code: '23505' })).toBe(true)
    expect(isUniqueViolationError({ name: 'UniqueConstraintViolationException' })).toBe(true)
  })
  it('rejects anything else (a real error must still propagate)', () => {
    expect(isUniqueViolationError({ code: '23503' })).toBe(false)
    expect(isUniqueViolationError(new Error('boom'))).toBe(false)
    expect(isUniqueViolationError(null)).toBe(false)
    expect(isUniqueViolationError(undefined)).toBe(false)
  })
})

describe('mapMlOrderStatusToFulfillment — US-2 status mapping', () => {
  it('paid + shipped/delivered → the matching transition', () => {
    expect(mapMlOrderStatusToFulfillment('paid', 'shipped')).toBe('shipped')
    expect(mapMlOrderStatusToFulfillment('paid', 'delivered')).toBe('delivered')
  })
  it('a non-paid order never transitions, regardless of shipment status', () => {
    expect(mapMlOrderStatusToFulfillment('payment_required', 'shipped')).toBeNull()
    expect(mapMlOrderStatusToFulfillment('cancelled', 'delivered')).toBeNull()
    expect(mapMlOrderStatusToFulfillment(null, 'delivered')).toBeNull()
  })
  it('pre-ship / failed / unknown shipment statuses are a deliberate no-op', () => {
    for (const s of ['pending', 'handling', 'ready_to_ship', 'not_delivered', 'cancelled', 'weird_status', null, undefined]) {
      expect(mapMlOrderStatusToFulfillment('paid', s)).toBeNull()
    }
  })
})

describe('shouldApplyFulfillmentTransition — forward-only, replay-safe (US-2 acceptance)', () => {
  it('applies a genuine forward move', () => {
    expect(shouldApplyFulfillmentTransition('not_fulfilled', 'shipped')).toBe(true)
    expect(shouldApplyFulfillmentTransition('shipped', 'delivered')).toBe(true)
    expect(shouldApplyFulfillmentTransition(null, 'shipped')).toBe(true) // unset ⇒ treated as not-yet-fulfilled
  })
  it('a replay of the same state is a no-op', () => {
    expect(shouldApplyFulfillmentTransition('shipped', 'shipped')).toBe(false)
    expect(shouldApplyFulfillmentTransition('delivered', 'delivered')).toBe(false)
  })
  it('never regresses — a stale "shipped" after "delivered" is a no-op', () => {
    expect(shouldApplyFulfillmentTransition('delivered', 'shipped')).toBe(false)
  })
  it('a canceled order never auto-advances', () => {
    expect(shouldApplyFulfillmentTransition('canceled', 'shipped')).toBe(false)
    expect(shouldApplyFulfillmentTransition('canceled', 'delivered')).toBe(false)
  })
  it('null target is always false', () => {
    expect(shouldApplyFulfillmentTransition('not_fulfilled', null)).toBe(false)
  })
})

describe('isMlCancelledStatus — only ML\'s unambiguous full-order cancel', () => {
  it('cancelled → true; every other status (incl. paid/refund-shaped-but-undefined) → false', () => {
    expect(isMlCancelledStatus('cancelled')).toBe(true)
    expect(isMlCancelledStatus('paid')).toBe(false)
    expect(isMlCancelledStatus('invalid')).toBe(false)
    expect(isMlCancelledStatus(null)).toBe(false)
    expect(isMlCancelledStatus(undefined)).toBe(false)
  })
})

describe('decideMlOrderCancel — US-4 exactly-once cancel/refund mapping', () => {
  it('never materialized (no row, or no medusa_order_id yet) → skip', () => {
    expect(decideMlOrderCancel(null, 'cancelled', null)).toEqual({ kind: 'skip' })
    expect(decideMlOrderCancel(undefined, 'cancelled', null)).toEqual({ kind: 'skip' })
    expect(
      decideMlOrderCancel(
        { medusa_order_id: null, cancelled_at: null, edge_logged_at: null, inventory_delta: 2 },
        'cancelled',
        null,
      ),
    ).toEqual({ kind: 'skip' })
  })
  it('ML status isn\'t a cancel → skip, regardless of fulfillment state', () => {
    const applied = { medusa_order_id: 'order_1', cancelled_at: null, edge_logged_at: null, inventory_delta: 2 }
    expect(decideMlOrderCancel(applied, 'paid', null)).toEqual({ kind: 'skip' })
    expect(decideMlOrderCancel(applied, null, null)).toEqual({ kind: 'skip' })
  })
  it('already cancelled (cancelled_at set) → skip — a replayed notification changes nothing', () => {
    const applied = {
      medusa_order_id: 'order_1',
      cancelled_at: new Date().toISOString(),
      edge_logged_at: null,
      inventory_delta: 2,
    }
    expect(decideMlOrderCancel(applied, 'cancelled', null)).toEqual({ kind: 'skip' })
  })
  it('materialized, not yet cancelled, not yet shipped → restock-and-cancel with the row\'s own inventory_delta', () => {
    const applied = { medusa_order_id: 'order_1', cancelled_at: null, edge_logged_at: null, inventory_delta: 3 }
    expect(decideMlOrderCancel(applied, 'cancelled', null)).toEqual({ kind: 'restock-and-cancel', restockQty: 3 })
    expect(decideMlOrderCancel(applied, 'cancelled', 'not_fulfilled')).toEqual({
      kind: 'restock-and-cancel',
      restockQty: 3,
    })
  })
  it('already shipped or beyond when ML cancels → log-edge, never auto-restocked/auto-cancelled', () => {
    const applied = { medusa_order_id: 'order_1', cancelled_at: null, edge_logged_at: null, inventory_delta: 3 }
    expect(decideMlOrderCancel(applied, 'cancelled', 'shipped')).toEqual({
      kind: 'log-edge',
      code: 'ML_CANCEL_AFTER_FULFILLMENT',
    })
    expect(decideMlOrderCancel(applied, 'cancelled', 'partially_shipped').kind).toBe('log-edge')
  })
  it('a log-edge case already logged (edge_logged_at set) → skip — never repeats the note every reconcile pass', () => {
    const applied = {
      medusa_order_id: 'order_1',
      cancelled_at: null,
      edge_logged_at: new Date().toISOString(),
      inventory_delta: 3,
    }
    expect(decideMlOrderCancel(applied, 'cancelled', 'shipped')).toEqual({ kind: 'skip' })
  })
})

describe('signature regression smoke — one ML sale moves stock EXACTLY ONCE (Sprint 1+2 combined)', () => {
  // A tiny in-memory simulation driven purely by the exported decision
  // functions — this IS the correctness core `applyMlOrderToLink`/
  // `applyMlOrderCancel` compose around; proving it here proves the invariant
  // the README's "Deploy order" section requires at every sprint: an ML sale
  // moves stock exactly once, flag ON and flag OFF — now extended through a
  // cancel + a replay of the ORIGINAL sale notification (a case decideMlOrderApply
  // must keep skipping even after the row's been cancelled, since it only looks
  // at medusa_order_id, never cancelled_at).
  type Row = {
    id: string
    medusa_order_id: string | null
    cancelled_at: string | null
    edge_logged_at: string | null
    inventory_delta: number
  }

  function runScenario(ordersEnabled: boolean) {
    let stocked = 10
    let row: Row | null = null
    let decrements = 0
    let restocks = 0

    // 1. First sight of the sale — always decrements once, materializes only if enabled.
    const first = decideMlOrderApply(row, ordersEnabled)
    expect(first).toEqual({ kind: 'apply', materializeOrder: ordersEnabled })
    const soldQty = 3
    const decrement = safeDecrement(stocked, 0, soldQty)
    stocked -= decrement
    decrements++
    row = {
      id: 'mlao_1',
      medusa_order_id: ordersEnabled ? 'order_1' : null,
      cancelled_at: null,
      edge_logged_at: null,
      inventory_delta: decrement,
    }

    // 2. A webhook replay of the SAME sale notification — must never decrement again.
    const replay = decideMlOrderApply(row, ordersEnabled)
    expect(replay.kind).not.toBe('apply') // 'skip' or (flag-off case) still 'skip'
    if (replay.kind === 'apply') decrements++ // would fail the assertion above first

    // 3. Cancel — only reachable/meaningful once an order was actually materialized.
    if (row.medusa_order_id) {
      const cancelDecision = decideMlOrderCancel(row, 'cancelled', 'not_fulfilled')
      expect(cancelDecision).toEqual({ kind: 'restock-and-cancel', restockQty: row.inventory_delta })
      if (cancelDecision.kind === 'restock-and-cancel') {
        stocked += cancelDecision.restockQty
        restocks++
        row = { ...row, cancelled_at: new Date().toISOString() }
      }

      // 4. A replayed cancel notification — must never restock a second time.
      const cancelReplay = decideMlOrderCancel(row, 'cancelled', 'not_fulfilled')
      expect(cancelReplay).toEqual({ kind: 'skip' })

      // 5. The ORIGINAL sale notification replaying AFTER cancellation — must
      // still skip (decideMlOrderApply only ever looks at medusa_order_id, not
      // cancelled_at), so a cancelled order can never be re-decremented.
      const saleReplayAfterCancel = decideMlOrderApply(row, ordersEnabled)
      expect(saleReplayAfterCancel).toEqual({ kind: 'skip' })
    }

    return { stocked, decrements, restocks, finalRow: row }
  }

  it('flag ON: decrement once, materialize, cancel restocks exactly the decremented amount, net stock unchanged', () => {
    const result = runScenario(true)
    expect(result.decrements).toBe(1)
    expect(result.restocks).toBe(1)
    expect(result.stocked).toBe(10) // -3 then +3 — back to baseline, never double-moved
    expect(result.finalRow?.cancelled_at).not.toBeNull()
  })

  it('flag OFF: decrement once, no materialization, so no cancel/restock ever applies (nothing to cancel)', () => {
    const result = runScenario(false)
    expect(result.decrements).toBe(1)
    expect(result.restocks).toBe(0)
    expect(result.stocked).toBe(7) // -3, stays decremented — no order was ever created to cancel
    expect(result.finalRow?.medusa_order_id).toBeNull()
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
