/**
 * POST /internal/backfill-customer-clerk
 *
 * One-time: stamp `customer.metadata.clerk_user_id` on existing customers by
 * looking each one up in Clerk by email. After this, buyer-order resolution
 * (resolveBuyerCustomerIds) finds historical customers via the fast metadata
 * path. Also ensures an index on (metadata->>'clerk_user_id').
 *
 * Idempotent — skips customers already stamped. Safe to re-run.
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'

async function clerkUserIdForEmail(email: string, secret: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}&limit=1`,
      { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(5000) },
    )
    if (!res.ok) return null
    const users = await res.json() as Array<{ id?: string }>
    return users?.[0]?.id ?? null
  } catch {
    return null
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!process.env.MEDUSA_INTERNAL_SECRET || req.headers['x-internal-secret'] !== process.env.MEDUSA_INTERNAL_SECRET) {
    return res.status(401).json({ message: 'Unauthorized' })
  }
  const secret = process.env.CLERK_SECRET_KEY
  if (!secret) return res.status(500).json({ message: 'CLERK_SECRET_KEY not set' })

  const customerService = req.scope.resolve(Modules.CUSTOMER) as any
  const knex = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as any

  // Index for the metadata lookup (idempotent).
  try {
    await knex.raw(`CREATE INDEX IF NOT EXISTS customer_clerk_user_id_idx ON customer ((metadata->>'clerk_user_id'))`)
  } catch (e) {
    console.error('[backfill-customer-clerk] index error:', e)
  }

  const customers: Array<{ id: string; email: string | null; metadata: Record<string, unknown> | null }> =
    await customerService.listCustomers({}, { select: ['id', 'email', 'metadata'], take: 1000 })

  let stamped = 0, skipped = 0, unmatched = 0
  for (const c of customers) {
    if ((c.metadata as Record<string, unknown> | null)?.clerk_user_id) { skipped++; continue }
    if (!c.email) { unmatched++; continue }
    const clerkId = await clerkUserIdForEmail(String(c.email), secret)
    if (!clerkId) { unmatched++; continue }
    try {
      await customerService.updateCustomers(c.id, { metadata: { ...(c.metadata ?? {}), clerk_user_id: clerkId } })
      stamped++
    } catch (e) {
      console.error('[backfill-customer-clerk] update error:', c.id, e)
      unmatched++
    }
  }

  return res.json({ ok: true, total: customers.length, stamped, skipped, unmatched })
}
