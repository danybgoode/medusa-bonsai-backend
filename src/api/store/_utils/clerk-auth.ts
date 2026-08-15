/**
 * Shared Clerk JWT auth helpers for Store API routes.
 *
 * Why not Medusa's auth_context?
 * The Clerk auth middleware only populates auth_context for routes registered as
 * protected via Medusa's middleware config, and these custom /store/* routes are not
 * in that list. So identity is established by `src/api/middlewares.ts`, which verifies
 * the bearer token against Clerk's JWKS and records the result on the request. The
 * helpers here READ that verified result and nothing else.
 *
 * This file used to base64-DECODE the JWT payload and return its `sub`, with a comment
 * claiming "Clerk's public key validation happens at the edge (middleware)". No such
 * middleware existed anywhere in this repo, so the claim was false and every caller of
 * `extractClerkUserId` was authenticating on an attacker-supplied string. Nothing in
 * this module reads an unverified token any more; a route the middleware does not cover
 * gets `null` and denies, and `clerk-verify` logs the matcher gap.
 */

import { MedusaRequest } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'
import { readVerifiedClerkIdentity } from './clerk-verify'

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

/** The Clerk user ID (`sub`) of the caller, or null if the token did not verify. */
export function extractClerkUserId(req: MedusaRequest): string | null {
  const identity = readVerifiedClerkIdentity(req)
  return identity.state === 'verified' ? identity.identity.sub : null
}

/** The caller's email from the verified Clerk JWT, if the token template includes it. */
export function extractClerkEmail(req: MedusaRequest): string | null {
  const identity = readVerifiedClerkIdentity(req)
  return identity.state === 'verified' ? identity.identity.email ?? null : null
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

/**
 * Finds the Seller record for the authenticated Clerk user. Returns null if not found.
 *
 * `sellerClerkUserId` is returned even though the caller supplied it: the whole
 * point is that downstream consumers (`normalizeMedusaOrder`) need the seller's
 * Clerk id to address a NOTIFICATION at them, and re-deriving it from the request
 * at each of the ~45 call sites is how it ended up hardcoded `null` instead.
 */
export async function resolveSeller(
  req: MedusaRequest,
): Promise<{ sellerId: string; sellerName: string; sellerClerkUserId: string } | null> {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return null
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (!seller) return null
  return { sellerId: seller.id, sellerName: seller.name, sellerClerkUserId: clerkUserId }
}
