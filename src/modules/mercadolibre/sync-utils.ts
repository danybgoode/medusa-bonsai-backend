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

/**
 * Only a **paid** ML order has consumed stock. Applying every order id (incl.
 * `payment_required` / `cancelled` / `invalid`) would wrongly, permanently reduce
 * Medusa inventory. A later `paid` notification for the same order applies then
 * (idempotent per order id). ML cancellation/refund restock is out of S4 scope.
 */
export function isSoldOrderStatus(status: string | null | undefined): boolean {
  return status === 'paid'
}

// ── Exactly-once sale application (US-0, ml-orders-native S1) ────────────────────
// The dedupe key is the ML **order id** — the natural exactly-once key for a sale.
// Supersedes the capped 500-entry ring that used to ride the linkage metadata (a
// ring evicts, so a very-delayed replay could theoretically outrun it) with a
// durable `ml_applied_order` DB row, `unique(link_id, ml_order_id)`. (Earlier
// drafts keyed on the notification `_id` and fell back to the `resource` path —
// unsafe: distinct sales of the same item share a resource and would be dropped
// as replays.)

export type AppliedOrderRow = { id: string; medusa_order_id: string | null } | null | undefined

export type ApplyDecision =
  | { kind: 'skip' } // a row already exists for (link, orderId) — already applied, no matter what
  | { kind: 'apply'; materializeOrder: boolean } // fresh — stock decrement always runs; order creation only if the flag is on

/**
 * The exactly-once + "one inventory effect, flag on or off" decision (US-0/US-1).
 * An existing row always wins (idempotent replay, regardless of the current flag
 * value — flipping the flag mid-flight must never re-materialize an already-applied
 * sale). A fresh order always gets the stock decrement; it additionally gets a
 * Medusa order only when `ordersEnabled` is true — so the inventory effect count
 * never depends on the flag, only the order-creation side effect does.
 */
export function decideMlOrderApply(existing: AppliedOrderRow, ordersEnabled: boolean): ApplyDecision {
  if (existing) return { kind: 'skip' }
  return { kind: 'apply', materializeOrder: ordersEnabled }
}

/**
 * Classify a DB write error as a unique-constraint violation (Postgres code
 * `23505`, or MikroORM's own exception name) — the defense-in-depth path when two
 * writers race the insert despite the per-link lock (e.g. a lock-service outage).
 * A caller that sees this should treat the row as already-applied, not throw.
 */
export function isUniqueViolationError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  const name = (e as { name?: string } | null)?.name
  return code === '23505' || name === 'UniqueConstraintViolationException'
}

// ── ML → Medusa fulfillment-state mapping (US-2, ml-orders-native S1) ────────────
// Real ML status vocabularies (confirmed against Mercado Libre's public API docs):
// order.status ∈ {confirmed, payment_required, payment_in_process, partially_paid,
// paid, cancelled, invalid}; shipment.status ∈ {pending, handling, ready_to_ship,
// shipped, delivered, not_delivered, cancelled}. Only PAID orders' shipments are
// ever mapped — everything else is a deliberate no-op (never guess a transition
// on an unpaid/cancelled/unknown status).

export type MlFulfillmentTransition = 'shipped' | 'delivered'

/**
 * Map an ML order + shipment status pair to the Medusa fulfillment transition to
 * apply, or `null` for "no transition" (pre-payment states, `not_delivered`/
 * `cancelled`, or an unrecognized value — the caller logs the no-op rather than
 * guessing). Pure, no I/O.
 */
export function mapMlOrderStatusToFulfillment(
  orderStatus: string | null | undefined,
  shipmentStatus: string | null | undefined,
): MlFulfillmentTransition | null {
  if (orderStatus !== 'paid') return null
  if (shipmentStatus === 'delivered') return 'delivered'
  if (shipmentStatus === 'shipped') return 'shipped'
  return null
}

/** Real Medusa `FulfillmentStatus` values, ranked so a transition only ever moves forward. */
const FULFILLMENT_RANK: Record<string, number> = {
  not_fulfilled: 0,
  partially_fulfilled: 0,
  fulfilled: 0,
  partially_shipped: 1,
  shipped: 1,
  partially_delivered: 2,
  delivered: 2,
}

/**
 * Replay/out-of-order safety (US-2 acceptance: "replay changes nothing"): apply
 * `target` only if it's a strictly FORWARD move from the order's current
 * `fulfillment_status`. A stale "shipped" arriving after "delivered" was already
 * recorded, or the exact same status replaying, is a no-op — never regresses or
 * double-applies. A `canceled` order is terminal and never auto-advances,
 * regardless of target (checked explicitly, not via the rank table — a
 * cancellation isn't "behind" `not_fulfilled`, it's a different axis entirely).
 * An unrecognized current status is treated as rank 0 (the safe "not yet
 * fulfilled" assumption).
 */
export function shouldApplyFulfillmentTransition(
  currentFulfillmentStatus: string | null | undefined,
  target: MlFulfillmentTransition | null,
): boolean {
  if (!target) return false
  if (currentFulfillmentStatus === 'canceled') return false
  const currentRank = FULFILLMENT_RANK[currentFulfillmentStatus ?? ''] ?? 0
  return FULFILLMENT_RANK[target] > currentRank
}
