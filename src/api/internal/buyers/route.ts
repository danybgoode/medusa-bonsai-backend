/**
 * GET /internal/buyers  (READ-ONLY)
 *
 * The distinct email addresses of everyone who has actually placed an order —
 * the only truthful definition of "buyer" this platform has. Medusa owns orders,
 * so it owns this list; the storefront cannot derive it from the Supabase mirror
 * (`marketplace_orders` has 0 rows and is legacy).
 *
 * Exists for the admin broadcast surface (`/admin/comunicaciones` → Difusión), which
 * needs to show an operator exactly who a message would reach BEFORE sending it.
 *
 * Auth: x-internal-secret. No writes, no side effects.
 *
 * Guest orders are included deliberately: they have an email and they bought
 * something, so an operational notice concerns them. A missing/blank email is
 * dropped rather than emitted as an empty recipient.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { internalSecretOk } from '../../../lib/internal-auth'

/** Max orders scanned. Bounded so this route cannot become a slow full-table read. */
const SCAN_LIMIT = 5000

type OrderEmailRow = { email?: unknown; created_at?: unknown }

/**
 * Pure: fold order rows into a de-duplicated, case-normalised recipient list.
 *
 * Case-normalised because `Ana@x.com` and `ana@x.com` are one inbox, and sending
 * twice to the same person is the failure this de-duplication exists to prevent.
 * The FIRST-seen spelling is kept for display; the lowercase form is the identity.
 */
export function foldBuyerEmails(rows: OrderEmailRow[]): { emails: string[]; scanned: number } {
  const seen = new Map<string, string>()
  for (const row of rows) {
    const raw = typeof row?.email === 'string' ? row.email.trim() : ''
    if (!raw || !raw.includes('@')) continue
    const key = raw.toLowerCase()
    if (!seen.has(key)) seen.set(key, raw)
  }
  return { emails: [...seen.values()].sort(), scanned: rows.length }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  // Fail CLOSED: a missing MEDUSA_INTERNAL_SECRET denies everyone.
  if (!internalSecretOk(req)) return res.status(401).json({ message: 'Unauthorized' })

  const query: any = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  let rows: OrderEmailRow[]
  try {
    const { data } = await query.graph({
      entity: 'order',
      fields: ['email', 'created_at'],
      pagination: { take: SCAN_LIMIT, order: { created_at: 'DESC' } },
    })
    rows = (data ?? []) as OrderEmailRow[]
  } catch (e) {
    // An unreadable list is NOT an empty list. Say so, and let the caller refuse to
    // send rather than quietly broadcast to nobody and report success.
    console.error('[internal/buyers] order read failed:', e)
    return res.status(503).json({ message: 'No se pudo leer la lista de compradores.', detail: String(e) })
  }

  const { emails, scanned } = foldBuyerEmails(rows)
  return res.json({
    emails,
    count: emails.length,
    orders_scanned: scanned,
    // Told plainly so a caller can see the list is capped rather than assume it is complete.
    truncated: scanned >= SCAN_LIMIT,
  })
}
