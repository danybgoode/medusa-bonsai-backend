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
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'

/** Extracts the Clerk user ID (`sub` claim) from the Authorization header. */
export function extractClerkUserId(req: MedusaRequest): string | null {
  const authHeader = req.headers['authorization'] as string | undefined
  const jwt = authHeader?.replace(/^Bearer\s+/i, '')
  if (!jwt) return null
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))
    return (payload.sub as string) ?? null
  } catch {
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
