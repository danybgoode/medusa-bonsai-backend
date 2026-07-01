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
 * How many units to actually remove from `stocked` for an ML sale of `soldQty`,
 * given the current `stocked`/`reserved` (US-11). It's the sold qty, capped at the
 * current **available** (`stocked − reserved`) so the relative decrement never
 * drives available below 0 and always honors Medusa's own reservations. This is
 * the exact clamp `decrementProductStock` applies — proving it here proves the
 * runtime primitive (not just a mirror). Under-decrement (sold > available) is the
 * safe direction; the drift alert surfaces the residual cross-channel oversell.
 */
export function safeDecrement(stocked: number, reserved: number, soldQty: number): number {
  const available = Math.max(0, clampAvailable(stocked) - clampAvailable(reserved))
  return Math.min(clampAvailable(soldQty), available)
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
export const APPLIED_ORDERS_CAP = 500

/**
 * Only a **paid** ML order has consumed stock. Applying every order id (incl.
 * `payment_required` / `cancelled` / `invalid`) would wrongly, permanently reduce
 * Medusa inventory. A later `paid` notification for the same order applies then
 * (idempotent per order id). ML cancellation/refund restock is out of S4 scope.
 */
export function isSoldOrderStatus(status: string | null | undefined): boolean {
  return status === 'paid'
}

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
