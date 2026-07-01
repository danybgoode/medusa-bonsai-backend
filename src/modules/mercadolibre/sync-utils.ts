/**
 * Mercado Libre module · Sprint 4 pure stock-sync helpers (the deterministic
 * backend gate — no DB, no network). The correctness core of the two-way stock
 * sync, built on the only model that is provably oversell-safe: **event/delta
 * application against a single source of truth (Medusa).**
 *
 * Why delta, not absolute-reconcile: comparing the two channels' absolute
 * available quantities cannot recover the truth when both sold independently
 * (baseline 5, ML sells 2 → 3, Miyagi sells 3 → 2; the true remaining is 0, but
 * `min(3,2)=2` — a 2-unit oversell). Instead each channel's **sale** is applied
 * to Medusa as a delta **exactly once** (idempotent per ML order id), and ML is
 * mirrored from Medusa. Applying the ML sale (−2) to a Medusa already at 2 yields
 * 0 — correct, and it composes with Medusa's own reservations.
 */

/** Clamp any quantity to a safe non-negative integer (the last line of defense). */
export function clampAvailable(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(n)) return 0
  return Math.max(0, Math.trunc(n))
}

/**
 * Apply a sale of `soldQty` units to a current available quantity (US-11). The
 * result is `available − soldQty`, clamped ≥ 0 — a sale can never drive stock
 * negative, and because it is a **delta** it composes correctly with sales on the
 * other channel and with Medusa's own reservations (unlike setting an absolute
 * from the other system, which would double-count or clobber local state).
 */
export function applySale(available: number, soldQty: number): number {
  return clampAvailable(clampAvailable(available) - clampAvailable(soldQty))
}

/**
 * Outbound idempotency (US-10): only mirror Medusa's available to ML when the
 * value changed since the last successful push. Pushing the current absolute
 * value means a burst collapses to the latest value and a retried trigger is a
 * no-op — so the same stock state is never written to ML twice.
 */
export function shouldPushStock(args: {
  currentAvailable: number
  lastPushedAvailable?: number | null
}): boolean {
  const cur = clampAvailable(args.currentAvailable)
  if (args.lastPushedAvailable == null) return true
  return cur !== clampAvailable(args.lastPushedAvailable)
}

// ── Exactly-once sale application (US-11) ────────────────────────────────────────
// The dedupe key is the ML **order id** — the natural exactly-once key for a sale.
// A bounded ring of applied order ids rides the linkage metadata, so the same ML
// order decrements Medusa once no matter how many notifications (or reconcile
// polls) surface it. (Earlier drafts keyed on the notification `_id` and fell back
// to the `resource` path — unsafe: distinct sales of the same item share a
// resource and would be dropped as replays.)
export type AppliedOrder = { id: string; ts: string }
export const APPLIED_ORDERS_CAP = 100

export function isOrderApplied(applied: AppliedOrder[] | null | undefined, orderId: string): boolean {
  if (!orderId) return false
  return Array.isArray(applied) && applied.some((o) => o.id === orderId)
}

/**
 * Append an applied ML order id to the bounded ring (drops the oldest past the
 * cap). A blank or already-present id returns the list unchanged, so the ring
 * only grows on a genuinely new order.
 */
export function recordAppliedOrder(
  applied: AppliedOrder[] | null | undefined,
  orderId: string,
  now: string = new Date().toISOString(),
  cap: number = APPLIED_ORDERS_CAP,
): AppliedOrder[] {
  const base = Array.isArray(applied) ? applied : []
  if (!orderId || base.some((o) => o.id === orderId)) return base
  const next = [...base, { id: orderId, ts: now }]
  return next.length > cap ? next.slice(next.length - cap) : next
}
