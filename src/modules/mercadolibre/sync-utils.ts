/**
 * Mercado Libre module · Sprint 4 pure stock-sync helpers (the deterministic
 * backend gate — no DB, no network). These are the correctness core of the
 * two-way stock sync: the oversell-safe reconcile decision, the outbound
 * idempotency predicate, and the replay-safe inbound dedupe ring.
 *
 * The one invariant everything protects: **no path can oversell.** A reconciled
 * quantity never exceeds either observed side and is never negative, so neither
 * channel can ever sell stock the other already sold.
 */

/**
 * Clamp any quantity to a safe non-negative integer. The last line of defense:
 * a negative/NaN/fractional value must never reach a Medusa inventory write or an
 * ML `available_quantity`.
 */
export function clampAvailable(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(n)) return 0
  return Math.max(0, Math.trunc(n))
}

/**
 * The oversell-safe reconcile decision (US-12). Given the two observed available
 * quantities (Medusa vs ML), the reconciled remaining is the **conservative
 * minimum** — it never exceeds either side and is never negative. So when both
 * sides moved near-simultaneously (each recorded a sale the other hasn't yet),
 * reconciling to the minimum guarantees neither channel oversells.
 *
 *  - equal          → no change, drift 0
 *  - ML lower       → an ML sale Medusa hasn't recorded → pull Medusa down to ML
 *  - Medusa lower   → a Miyagi sale ML hasn't reflected → push Medusa down to ML
 *  - both moved     → target = min(both); neither can sell what the other sold
 *
 * `drift` is how far apart the two sides were (for the drift alert / logging).
 */
export function reconcileStock(args: { medusaAvailable: number; mlAvailable: number }): {
  target: number
  drift: number
} {
  const m = clampAvailable(args.medusaAvailable)
  const l = clampAvailable(args.mlAvailable)
  return { target: Math.min(m, l), drift: Math.abs(m - l) }
}

/**
 * Outbound idempotency (US-10): only push to ML when the available quantity
 * actually changed since the last successful push. Pushing the *current absolute*
 * value means a burst of N changes collapses to the latest value, and a
 * retried/duplicated trigger with an unchanged value is a no-op — so the same
 * stock state is never written to ML twice.
 */
export function shouldPushStock(args: {
  currentAvailable: number
  lastPushedAvailable?: number | null
}): boolean {
  const cur = clampAvailable(args.currentAvailable)
  if (args.lastPushedAvailable == null) return true
  return cur !== clampAvailable(args.lastPushedAvailable)
}

// ── Replay-safe inbound dedupe (US-11) ──────────────────────────────────────────
// ML can redeliver a webhook notification; each carries a notification id. We keep
// a bounded ring of processed ids on the linkage metadata so a redelivery is a
// no-op (the events-ticketing reconcileOrderTickets pattern).
export type ProcessedEvent = { id: string; ts: string }
export const PROCESSED_EVENTS_CAP = 50

export function isProcessedNotification(
  processed: ProcessedEvent[] | null | undefined,
  id: string,
): boolean {
  if (!id) return false
  return Array.isArray(processed) && processed.some((e) => e.id === id)
}

/**
 * Append a processed-notification id to the bounded ring (drops the oldest past
 * the cap). A blank id or an already-present id returns the list unchanged, so
 * the ring only ever grows on a genuinely new notification.
 */
export function recordProcessedNotification(
  processed: ProcessedEvent[] | null | undefined,
  id: string,
  now: string = new Date().toISOString(),
  cap: number = PROCESSED_EVENTS_CAP,
): ProcessedEvent[] {
  const base = Array.isArray(processed) ? processed : []
  if (!id || base.some((e) => e.id === id)) return base
  const next = [...base, { id, ts: now }]
  return next.length > cap ? next.slice(next.length - cap) : next
}
