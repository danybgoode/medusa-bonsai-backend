/**
 * POST /store/customers/sync
 *
 * Finds-or-creates a Medusa Customer record for the Clerk-authenticated user.
 * Call this from the frontend on checkout start so orders are linked to the
 * correct Medusa customer (and thus appear in /account/orders from Medusa).
 *
 * Auth: Clerk JWT in Authorization header.
 *
 * Body: { email: string; first_name?: string; last_name?: string }
 *
 * Response: { customer_id: string }
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { extractClerkUserId, resolveOrCreateBuyerCustomer } from '../../_utils/clerk-auth'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const body = req.body as {
    email?: string
    first_name?: string
    last_name?: string
  }

  if (!body.email) {
    return res.status(400).json({ message: 'email is required' })
  }

  // Find-or-create the ONE canonical customer for this Clerk buyer, keyed by
  // metadata.clerk_user_id + email (Medusa v2 customer has no external_id column).
  const customerId = await resolveOrCreateBuyerCustomer(req.scope, {
    clerkUserId,
    email: body.email,
    firstName: body.first_name ?? null,
    lastName: body.last_name ?? null,
  })

  if (!customerId) {
    return res.status(500).json({ message: 'Failed to create customer' })
  }

  return res.json({ customer_id: customerId })
}
