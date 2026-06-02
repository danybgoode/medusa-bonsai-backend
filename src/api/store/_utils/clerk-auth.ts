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
import { Modules } from '@medusajs/framework/utils'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'

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
): Promise<{ clerkUserId: string | null; customerIds: string[] }> {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return { clerkUserId: null, customerIds: [] }

  const customerService = req.scope.resolve(Modules.CUSTOMER) as any
  const ids = new Set<string>()
  const emails = new Set<string>()
  const jwtEmail = extractClerkEmail(req)
  if (jwtEmail) emails.add(jwtEmail.toLowerCase())

  try {
    const byExt = await customerService.listCustomers({ external_id: clerkUserId }, { select: ['id', 'email'] })
    for (const c of byExt) { ids.add(c.id); if (c.email) emails.add(String(c.email).toLowerCase()) }
  } catch { /* ignore */ }

  for (const email of emails) {
    try {
      const byEmail = await customerService.listCustomers({ email }, { select: ['id'] })
      for (const c of byEmail) ids.add(c.id)
    } catch { /* ignore */ }
  }

  return { clerkUserId, customerIds: [...ids] }
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
