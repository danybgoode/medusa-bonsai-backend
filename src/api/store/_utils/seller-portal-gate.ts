/**
 * seller-portal-gate.ts — may this seller still WRITE through the portal?
 * (tenant-lifecycle-admin · D2c, S2.3)
 *
 * ── WHY A MIDDLEWARE AND NOT 45 ROUTE EDITS ───────────────────────────────────
 * `resolveSeller` has 45 call sites. Editing each one is how a guard ends up covering
 * the doors somebody happened to find rather than the population — the exact failure
 * `LEARNINGS.md` records, and the same reasoning `middlewares.ts` already gives for
 * preferring subtree prefixes over per-route entries. `/store/sellers/me` is a
 * subtree; the gate belongs on the subtree.
 *
 * ── READS PASS, WRITES REFUSE ─────────────────────────────────────────────────
 * A paused merchant must still be able to SEE their own shop, orders and payouts —
 * that is how they understand what happened and what they still have. What they may
 * not do is change anything or transact. So the method decides: `GET`/`HEAD` pass
 * through untouched, and every mutating method is refused.
 *
 * ── WHY 423 AND NOT 401 OR 404 ────────────────────────────────────────────────
 * The seller IS authenticated and the resource DOES exist — 401 and 404 would both be
 * lies, and both would render as "something is broken" in a portal rather than "your
 * account is paused". 423 Locked says exactly what is true: the resource is in a state
 * that forbids the method. The body names the state so the portal can explain it,
 * which is the entire point of this story — a merchant who sees a broken screen files
 * a bug; a merchant who sees "tu cuenta está en pausa" contacts the operator.
 *
 * ── UNRESOLVABLE IS NOT REFUSED; UNREADABLE IS ────────────────────────────────
 * If the caller has no verified identity, or no seller row, this gate passes through
 * and the route answers with its own 401/404 as it always has. Refusing here would
 * turn "not a seller yet" into "your account is locked", which is worse than the
 * status quo and would break onboarding.
 *
 * But a seller we FAILED TO LOOK UP is a different case from one that is not there,
 * and it must NOT pass. An earlier revision let a lookup error through, reasoning
 * that a gate firing on a database blip was worse than one that occasionally missed.
 * That is the wrong trade for a WRITE gate: it means an attacker (or bad luck) who
 * induces a transient failure gets exactly the mutation this gate promises to
 * prohibit. Caught by cross-family review, and it contradicted this repo's own
 * fail-closed rule. Three states: active passes, not-active is 423, and unreadable is
 * a retryable 503.
 *
 * Pure: no container, no database, no request object. The middleware is the shell.
 */
import { parseSellerStatus, sellerAdmits, type SellerStatus } from '../../../lib/seller-status'

/** Methods that change something. Everything else is a read. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function isWriteMethod(method: unknown): boolean {
  return typeof method === 'string' && WRITE_METHODS.has(method.toUpperCase())
}

export type PortalRefusal =
  | {
      readonly status: 423
      readonly body: {
        readonly code: 'seller_not_active'
        /** The state itself, so the portal can distinguish paused from deleted. */
        readonly seller_status: SellerStatus | 'paused' | 'deleted'
        readonly message: string
      }
    }
  | {
      /**
       * We could not determine the status. RETRYABLE, and distinct from 423 on
       * purpose: 423 means "your account is paused" (a durable fact the merchant
       * must act on), 503 means "try again" (our problem, not theirs). Collapsing
       * them would tell a healthy merchant their account was paused because a query
       * timed out.
       */
      readonly status: 503
      readonly body: {
        readonly code: 'seller_status_unavailable'
        readonly message: string
      }
    }

/** es-MX, because this reaches a merchant's screen (AGENTS rule 5). */
const MESSAGES: Record<SellerStatus, string> = {
  active: '', // unreachable — an active seller is never refused
  paused: 'Tu cuenta está en pausa. Puedes ver tu información, pero no hacer cambios ni vender. '
    + 'Escríbenos para reactivarla.',
  deleted: 'Esta cuenta fue eliminada. Puedes consultar tu historial, pero ya no es posible '
    + 'hacer cambios ni vender.',
}

const UNAVAILABLE_MESSAGE =
  'No pudimos verificar el estado de tu cuenta, así que no podemos guardar cambios en este '
  + 'momento. Intenta de nuevo en unos minutos.'

/** The refusal for "we could not determine the status" — a lookup failure, or an unparseable value. */
export const PORTAL_STATUS_UNAVAILABLE: PortalRefusal = {
  status: 503,
  body: { code: 'seller_status_unavailable', message: UNAVAILABLE_MESSAGE },
}

/**
 * Decide whether a portal request must be refused.
 *
 * `null` means "let it through" — either because it is a read, or because the seller
 * could not be resolved (the route's own auth then applies), or because the seller is
 * active.
 */
export function decidePortalGate(input: {
  readonly method: unknown
  /**
   * The resolved seller row; `null`/`undefined` when there is none.
   *
   * `'unavailable'` is a THIRD input state, not a missing row: the caller could not
   * complete the lookup. It refuses (503) rather than passing, because a write gate
   * that fails open on a lookup error can be bypassed by inducing one.
   */
  readonly seller: { readonly status?: unknown } | null | undefined | 'unavailable'
}): PortalRefusal | null {
  if (!isWriteMethod(input.method)) return null
  if (input.seller === 'unavailable') return PORTAL_STATUS_UNAVAILABLE
  if (!input.seller) return null

  const status = parseSellerStatus(input.seller.status)
  if (sellerAdmits(status)) return null
  // An unparseable stored value is the same class of fact as a failed lookup: we do
  // not know the state, so we do not permit the write.
  if (status === null) return PORTAL_STATUS_UNAVAILABLE

  return {
    status: 423,
    body: {
      code: 'seller_not_active',
      seller_status: status,
      message: MESSAGES[status],
    },
  }
}
