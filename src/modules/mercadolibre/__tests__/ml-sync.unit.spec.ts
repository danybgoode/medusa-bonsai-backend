import {
  clampAvailable,
  reconcileStock,
  shouldPushStock,
  isProcessedNotification,
  recordProcessedNotification,
  PROCESSED_EVENTS_CAP,
  type ProcessedEvent,
} from '../sync-utils'

/**
 * Mercado Libre module · Sprint 4 pure stock-sync helpers (the deterministic
 * backend gate). No DB, no network. Proves the oversell invariant (a reconciled
 * quantity never exceeds either side and is never negative — US-12), the outbound
 * push idempotency (US-10), and the replay-safe inbound dedupe ring (US-11).
 */

describe('clampAvailable', () => {
  it('floors to a non-negative integer; null/NaN/negative → 0', () => {
    expect(clampAvailable(5)).toBe(5)
    expect(clampAvailable(0)).toBe(0)
    expect(clampAvailable(-3)).toBe(0)
    expect(clampAvailable(2.9)).toBe(2)
    expect(clampAvailable(null)).toBe(0)
    expect(clampAvailable(undefined)).toBe(0)
    expect(clampAvailable(Number.NaN)).toBe(0)
    expect(clampAvailable(Infinity)).toBe(0)
  })
})

describe('reconcileStock — the oversell invariant', () => {
  it('equal sides → no change, drift 0', () => {
    expect(reconcileStock({ medusaAvailable: 5, mlAvailable: 5 })).toEqual({ target: 5, drift: 0 })
  })
  it('ML lower (an unrecorded ML sale) → target follows ML down', () => {
    expect(reconcileStock({ medusaAvailable: 10, mlAvailable: 7 })).toEqual({ target: 7, drift: 3 })
  })
  it('Medusa lower (an unreflected Miyagi sale) → target follows Medusa down', () => {
    expect(reconcileStock({ medusaAvailable: 2, mlAvailable: 10 })).toEqual({ target: 2, drift: 8 })
  })
  it('both sides moved (near-simultaneous sales) → conservative minimum, never oversells', () => {
    // Both started at 5; ML sold 2 (ML=3), Miyagi sold 3 (Medusa=2) → remaining 2, never 3.
    expect(reconcileStock({ medusaAvailable: 2, mlAvailable: 3 })).toEqual({ target: 2, drift: 1 })
  })
  it('negatives are clamped before comparison → target never negative', () => {
    expect(reconcileStock({ medusaAvailable: -4, mlAvailable: 3 })).toEqual({ target: 0, drift: 3 })
  })

  it('INVARIANT: over a wide grid, target ≤ min(both) and target ≥ 0 (no oversell, ever)', () => {
    for (let m = -3; m <= 20; m++) {
      for (let l = -3; l <= 20; l++) {
        const { target } = reconcileStock({ medusaAvailable: m, mlAvailable: l })
        const safeMin = Math.min(clampAvailable(m), clampAvailable(l))
        expect(target).toBeLessThanOrEqual(safeMin) // never exceeds either observed side
        expect(target).toBeGreaterThanOrEqual(0) // never negative
      }
    }
  })
})

describe('shouldPushStock — outbound idempotency (US-10)', () => {
  it('never pushed before → push', () => {
    expect(shouldPushStock({ currentAvailable: 4 })).toBe(true)
    expect(shouldPushStock({ currentAvailable: 4, lastPushedAvailable: null })).toBe(true)
  })
  it('unchanged since last push → skip (collapses a burst, safe on retry)', () => {
    expect(shouldPushStock({ currentAvailable: 4, lastPushedAvailable: 4 })).toBe(false)
    // clamp-equivalent values are treated as unchanged (4 vs 4.4 both clamp to 4)
    expect(shouldPushStock({ currentAvailable: 4.4, lastPushedAvailable: 4 })).toBe(false)
  })
  it('changed → push', () => {
    expect(shouldPushStock({ currentAvailable: 3, lastPushedAvailable: 4 })).toBe(true)
    expect(shouldPushStock({ currentAvailable: 0, lastPushedAvailable: 1 })).toBe(true)
  })
})

describe('processed-notification ring — replay-safe inbound (US-11)', () => {
  const now = '2026-06-30T00:00:00.000Z'

  it('a redelivered notification id is detected as processed → no-op', () => {
    const ring: ProcessedEvent[] = [{ id: 'wh_1', ts: now }]
    expect(isProcessedNotification(ring, 'wh_1')).toBe(true)
    expect(isProcessedNotification(ring, 'wh_2')).toBe(false)
    expect(isProcessedNotification(null, 'wh_1')).toBe(false)
    expect(isProcessedNotification(ring, '')).toBe(false)
  })

  it('recording a new id appends; a duplicate/blank id is a no-op', () => {
    const ring = recordProcessedNotification(null, 'wh_1', now)
    expect(ring).toEqual([{ id: 'wh_1', ts: now }])
    expect(recordProcessedNotification(ring, 'wh_1', now)).toBe(ring) // unchanged reference
    expect(recordProcessedNotification(ring, '', now)).toBe(ring)
    expect(recordProcessedNotification(ring, 'wh_2', now)).toHaveLength(2)
  })

  it('the ring is bounded at the cap (drops the oldest)', () => {
    let ring: ProcessedEvent[] = []
    for (let i = 0; i < PROCESSED_EVENTS_CAP + 10; i++) {
      ring = recordProcessedNotification(ring, `wh_${i}`, now)
    }
    expect(ring).toHaveLength(PROCESSED_EVENTS_CAP)
    expect(ring[0].id).toBe('wh_10') // first 10 dropped
    expect(ring[ring.length - 1].id).toBe(`wh_${PROCESSED_EVENTS_CAP + 9}`)
    // a replay of a still-remembered id is still caught
    expect(isProcessedNotification(ring, `wh_${PROCESSED_EVENTS_CAP + 9}`)).toBe(true)
  })
})
