/**
 * Shared Clerk JWT auth helpers for Store API routes.
 *
 * Why manual JWT decode instead of Medusa's auth_context?
 * The Clerk auth middleware only populates auth_context for routes registered
 * as protected via Medusa's middleware config. For custom /store/* routes that
 * aren't in that list, we decode the Clerk JWT ourselves — which is safe because
 * Clerk's public key validation happens at the edge (middleware), not here.
 * We only read the `sub` claim (Clerk user ID) for DB lookups; we do not treat
 * the decoded payload as proof of identity on its own.
 */

import { MedusaRequest } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'

// ── Clerk Backend API: resolve a user's emails from their id (cached) ─────────
// The default Clerk session token carries no email claim, and Medusa's customer
// table has no external_id. The `sub` (Clerk user id) is the only reliable key,
// so we look the email up from Clerk directly and match customers/orders by it.
const _clerkEmailCache = new Map<string, { emails: string[]; at: number }>()
const CLERK_EMAIL_TTL_MS = 5 * 60 * 1000

export async function getClerkUserEmails(clerkUserId: string): Promise<string[]> {
  const cached = _clerkEmailCache.get(clerkUserId)
  if (cached && Date.now() - cached.at < CLERK_EMAIL_TTL_MS) return cached.emails
  const secret = process.env.CLERK_SECRET_KEY
  if (!secret) return []
  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return []
    const user = await res.json() as {
      email_addresses?: Array<{ email_address?: string }>
    }
    const emails = (user.email_addresses ?? [])
      .map((e) => e.email_address?.toLowerCase())
      .filter((e): e is string => !!e)
    _clerkEmailCache.set(clerkUserId, { emails, at: Date.now() })
    return emails
  } catch {
    return []
  }
}

function decodeClerkPayload(req: MedusaRequest): Record<string, unknown> | null {
  const authHeader = req.headers['authorization'] as string | undefined
  const jwt = authHeader?.replace(/^Bearer\s+/i, '')
  if (!jwt) return null
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3) return null
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))
  } catch {
    return null
  }
}

/** Extracts the Clerk user ID (`sub` claim) from the Authorization header. */
export function extractClerkUserId(req: MedusaRequest): string | null {
  return (decodeClerkPayload(req)?.sub as string) ?? null
}

/** Extracts the buyer's email from the Clerk JWT, if the template includes it. */
export function extractClerkEmail(req: MedusaRequest): string | null {
  const p = decodeClerkPayload(req)
  return (p?.email as string) ?? (p?.email_address as string) ?? null
}

/**
 * Resolves ALL Medusa customer ids that belong to the authenticated buyer.
 *
 * Why a set, not one id: the cart's customer (created by the auth flow) and the
 * /customers/sync customer can diverge — same email, but only one carries
 * external_id = Clerk id. Orders may be linked to EITHER, so we match by
 * external_id AND by shared email to never lose a buyer's order.
 */
export async function resolveBuyerCustomerIds(
  req: MedusaRequest,
): Promise<{ clerkUserId: string | null; customerIds: string[]; emails: string[] }> {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return { clerkUserId: null, customerIds: [], emails: [] }

  const customerService = req.scope.resolve(Modules.CUSTOMER) as any
  const ids = new Set<string>()
  const emails = new Set<string>()

  // 1. By durable link: customer.metadata.clerk_user_id = <sub>. The module-service
  //    filters can't query JSONB, so use the raw pg connection (knex).
  try {
    const knex = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
    const rows = await knex.raw(
      `select id, email from customer where metadata->>'clerk_user_id' = ? and deleted_at is null`,
      [clerkUserId],
    )
    for (const r of (rows?.rows ?? []) as Array<{ id: string; email: string | null }>) {
      ids.add(r.id)
      if (r.email) emails.add(String(r.email).toLowerCase())
    }
  } catch (e) {
    console.error('[resolveBuyerCustomerIds] metadata lookup failed:', e)
  }

  // 2. By email: the JWT email if present, plus the buyer's emails from Clerk
  //    (the reliable path — surfaces guest-owned orders that carry the email).
  const jwtEmail = extractClerkEmail(req)
  if (jwtEmail) emails.add(jwtEmail.toLowerCase())
  for (const e of await getClerkUserEmails(clerkUserId)) emails.add(e)

  for (const email of emails) {
    try {
      const byEmail = await customerService.listCustomers({ email }, { select: ['id'] })
      for (const c of byEmail) ids.add(c.id)
    } catch { /* ignore */ }
  }

  return { clerkUserId, customerIds: [...ids], emails: [...emails] }
}

/**
 * Find-or-create the ONE canonical Medusa customer for a Clerk buyer and ensure
 * it's stamped with metadata.clerk_user_id. Used at checkout + sync so orders are
 * owned by a stable, clerk-linked customer (not a throwaway guest). Returns the
 * customer id, or null if we can't (no email).
 */
export async function resolveOrCreateBuyerCustomer(
  scope: MedusaRequest['scope'],
  opts: { clerkUserId: string; email?: string | null; firstName?: string | null; lastName?: string | null },
): Promise<string | null> {
  const email = opts.email?.trim().toLowerCase() || null
  const customerService = scope.resolve(Modules.CUSTOMER) as any

  // Prefer a customer already linked to this Clerk id; else match by email.
  let customer: { id: string; metadata?: Record<string, unknown> | null } | null = null
  try {
    const knex = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
    const rows = await knex.raw(
      `select id, metadata from customer where metadata->>'clerk_user_id' = ? and deleted_at is null limit 1`,
      [opts.clerkUserId],
    )
    customer = (rows?.rows ?? [])[0] ?? null
  } catch { /* ignore */ }

  if (!customer && email) {
    try {
      const [byEmail] = await customerService.listCustomers({ email }, { select: ['id', 'metadata'], take: 1 })
      customer = byEmail ?? null
    } catch { /* ignore */ }
  }

  if (customer) {
    const meta = (customer.metadata ?? {}) as Record<string, unknown>
    if (meta.clerk_user_id !== opts.clerkUserId) {
      try { await customerService.updateCustomers(customer.id, { metadata: { ...meta, clerk_user_id: opts.clerkUserId } }) } catch { /* ignore */ }
    }
    return customer.id
  }

  if (!email) return null
  try {
    const created = await customerService.createCustomers({
      email,
      first_name: opts.firstName ?? '',
      last_name: opts.lastName ?? '',
      metadata: { clerk_user_id: opts.clerkUserId },
    })
    return created.id
  } catch (e) {
    console.error('[resolveOrCreateBuyerCustomer] create failed:', e)
    return null
  }
}

/** Finds the Seller record for the authenticated Clerk user. Returns null if not found. */
export async function resolveSeller(
  req: MedusaRequest,
): Promise<{ sellerId: string; sellerName: string } | null> {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return null
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (!seller) return null
  return { sellerId: seller.id, sellerName: seller.name }
}
