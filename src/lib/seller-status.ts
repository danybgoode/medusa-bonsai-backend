/**
 * src/lib/seller-status.ts
 *
 * The seller lifecycle seam (tenant-lifecycle-admin · D1, D2).
 *
 * ── WHY ONE MODULE ────────────────────────────────────────────────────────────
 * "Is this shop open for business?" will be asked from three unrelated places — the
 * catalog reads, the checkout admission boundary, and the seller portal's write
 * routes — and the previous epic's post-mortem is explicit that a suspend flag
 * honoured by *some* consumers is worse than no feature at all: a shop that looks
 * paused in the admin and still sells through the API is a lie the platform tells
 * its operator. So the rule lives here once and is imported, never restated. A
 * paraphrased contract drifts permissive.
 *
 * ── WHAT IS ACTUALLY WIRED TODAY (S1) ─────────────────────────────────────────
 * Only the status route imports `sellerAdmits`. The catalog is made dark by the
 * sales-channel unlink, NOT by a read-path status check, and **checkout does not
 * consult this module at all yet** — a cart created before a pause can still
 * complete. S2.2 imports it into `checkout-admission.ts` and S2.3 into the portal's
 * write routes. Until then this is a primitive with one consumer, and describing it
 * as an enforced boundary would be exactly the overclaim this codebase records as
 * its most repeated documentation failure: a comment asserting a control that does
 * not exist.
 *
 * ── THREE STATES, AND NEVER A COERCED FOURTH ──────────────────────────────────
 * `parseSellerStatus` REFUSES an unrecognised value rather than defaulting it to
 * `active`. A row whose status we cannot read is not a row we may treat as open —
 * that is the difference between "I checked and it is fine" and "I could not check",
 * and collapsing the two is how a guard silently stops existing.
 *
 * Pure: no container, no database, no `process.env`. The routes are the I/O shell.
 */

export const SELLER_STATUSES = ['active', 'paused', 'deleted'] as const
export type SellerStatus = (typeof SELLER_STATUSES)[number]

/** The value a seller row carries before anyone has changed it. */
export const DEFAULT_SELLER_STATUS: SellerStatus = 'active'

export function isSellerStatus(value: unknown): value is SellerStatus {
  return typeof value === 'string' && (SELLER_STATUSES as readonly string[]).includes(value)
}

/**
 * Read a status off a seller row.
 *
 * `null`/`undefined` — the column is genuinely absent (a row read before the
 * migration, or a projection that did not select it). That is the ONLY case that
 * resolves to the default, because the column's own NOT NULL DEFAULT guarantees a
 * real row always has one.
 *
 * Anything else unrecognised returns `null` — unreadable, not active.
 */
export function parseSellerStatus(value: unknown): SellerStatus | null {
  if (value === null || value === undefined) return DEFAULT_SELLER_STATUS
  return isSellerStatus(value) ? value : null
}

/**
 * The ENFORCEMENT reader: like `parseSellerStatus`, but an ABSENT value is refused
 * rather than defaulted.
 *
 * The difference matters only on the two seams that gate money and mutations, and it
 * is the difference between a leniency and a hole. `parseSellerStatus` treats
 * `undefined` as `active` because a projection that did not select the column must
 * not black out an unrelated read — but on the checkout admission seam and the portal
 * write gate, `undefined` can ONLY mean the query stopped selecting `seller.status`
 * (the column is NOT NULL with a default, so a real row always has one). Defaulting
 * there would silently re-open every paused shop the moment someone edited a field
 * list. Caught by cross-family review; the previous revision defaulted, and the fail
 * would have been invisible.
 */
export function requireSellerStatus(value: unknown): SellerStatus | null {
  return isSellerStatus(value) ? value : null
}

/**
 * May this seller's catalog be shown and sold?
 *
 * Only `active` admits. `null` (unreadable) does NOT admit — see the header. This is
 * the single predicate the catalog, the admission seam and the portal all import.
 */
export function sellerAdmits(status: SellerStatus | null): boolean {
  return status === 'active'
}

/** Convenience for the common shape: a row that may or may not carry `status`. */
export function sellerRowAdmits(row: { status?: unknown } | null | undefined): boolean {
  if (!row) return false
  return sellerAdmits(parseSellerStatus(row.status))
}

export type SellerStatusTransition = {
  from: SellerStatus
  to: SellerStatus
}

export type TransitionRefusal = {
  ok: false
  /** Machine-readable so the route can pick a status code without re-deriving it. */
  reason: 'unknown_status' | 'deleted_is_terminal' | 'no_change'
  message: string
}

export type TransitionDecision = { ok: true; transition: SellerStatusTransition } | TransitionRefusal

/**
 * Decide a status transition BEFORE anything is written.
 *
 * Hoisted above every mutation on purpose: the owned-shop epic shipped a defect
 * where validation ran *after* the writes, so a rejected request persisted half of
 * itself and still returned an error. Deciding first makes a partial apply
 * structurally impossible rather than merely unlikely.
 *
 * `deleted` is terminal here. Undeleting is a real product decision (what happens to
 * the slug, the domain, the channel links?) and quietly allowing it through a status
 * PATCH would be inventing that decision in the wrong place. A refusal names it.
 */
export function decideStatusTransition(rawFrom: unknown, rawTo: unknown): TransitionDecision {
  const from = parseSellerStatus(rawFrom)
  const to = isSellerStatus(rawTo) ? rawTo : null

  if (from === null) {
    return { ok: false, reason: 'unknown_status', message: 'The seller carries an unrecognised status.' }
  }
  if (to === null) {
    return {
      ok: false,
      reason: 'unknown_status',
      message: `status must be one of ${SELLER_STATUSES.join(', ')}.`,
    }
  }
  if (from === to) {
    return { ok: false, reason: 'no_change', message: `The seller is already ${to}.` }
  }
  if (from === 'deleted') {
    return {
      ok: false,
      reason: 'deleted_is_terminal',
      message: 'A deleted shop cannot be restored through a status change.',
    }
  }
  return { ok: true, transition: { from, to } }
}

/** Does this transition need the seller's products pulled OUT of their channels? */
export function transitionUnlinks(transition: SellerStatusTransition): boolean {
  return transition.from === 'active' && transition.to !== 'active'
}

/** Does this transition need the previously-recorded channel links replayed? */
export function transitionRelinks(transition: SellerStatusTransition): boolean {
  return transition.from !== 'active' && transition.to === 'active'
}
