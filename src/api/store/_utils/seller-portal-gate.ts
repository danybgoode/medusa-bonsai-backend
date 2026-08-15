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
 * ── UNRESOLVABLE IS NOT REFUSED ───────────────────────────────────────────────
 * If the caller has no verified identity, or no seller row, this gate passes through
 * and the route answers with its own 401/404 as it always has. Refusing here would
 * turn "not a seller yet" into "your account is locked", which is worse than the
 * status quo and would break onboarding. Only a RESOLVED seller that is not active is
 * refused — and a resolved seller whose status cannot be parsed IS refused, because
 * "I could not read it" is not "it is fine".
 *
 * Pure: no container, no database, no request object. The middleware is the shell.
 */
import { parseSellerStatus, sellerAdmits, type SellerStatus } from '../../../lib/seller-status'

/** Methods that change something. Everything else is a read. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function isWriteMethod(method: unknown): boolean {
  return typeof method === 'string' && WRITE_METHODS.has(method.toUpperCase())
}

export type PortalRefusal = {
  readonly status: 423
  readonly body: {
    readonly code: 'seller_not_active'
    /** The state itself, so the portal can distinguish paused from deleted. */
    readonly seller_status: SellerStatus | 'unknown'
    readonly message: string
  }
}

/** es-MX, because this reaches a merchant's screen (AGENTS rule 5). */
const MESSAGES: Record<SellerStatus | 'unknown', string> = {
  active: '', // unreachable — an active seller is never refused
  paused: 'Tu cuenta está en pausa. Puedes ver tu información, pero no hacer cambios ni vender. '
    + 'Escríbenos para reactivarla.',
  deleted: 'Esta cuenta fue eliminada. Puedes consultar tu historial, pero ya no es posible '
    + 'hacer cambios ni vender.',
  unknown: 'No pudimos verificar el estado de tu cuenta, así que no podemos guardar cambios en '
    + 'este momento. Intenta de nuevo en unos minutos.',
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
  /** The resolved seller row, or `null`/`undefined` when there is none. */
  readonly seller: { readonly status?: unknown } | null | undefined
}): PortalRefusal | null {
  if (!isWriteMethod(input.method)) return null
  if (!input.seller) return null

  const status = parseSellerStatus(input.seller.status)
  if (sellerAdmits(status)) return null

  const named: SellerStatus | 'unknown' = status ?? 'unknown'
  return {
    status: 423,
    body: {
      code: 'seller_not_active',
      seller_status: named,
      message: MESSAGES[named],
    },
  }
}
