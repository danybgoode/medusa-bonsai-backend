/**
 * GET /store/customers/me/subscriptions
 *
 * Returns the authenticated buyer's active subscriptions.
 * Auth: Clerk JWT in Authorization header.
 *
 * Response: { subscriptions: Subscription[] }
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SUBSCRIPTIONS_MODULE } from '../../../../../modules/subscriptions'
import SubscriptionsModuleService from '../../../../../modules/subscriptions/service'
import { extractClerkUserId } from '../../../_utils/clerk-auth'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const subsService: SubscriptionsModuleService = req.scope.resolve(SUBSCRIPTIONS_MODULE)

  // Fetch by Clerk user ID
  const subscriptions = await (subsService as any).listSubscriptions(
    { clerk_user_id: clerkUserId },
    { order: { created_at: 'DESC' }, take: 100 }
  ).catch(() => [])

  return res.json({ subscriptions })
}

// ── PATCH /store/customers/me/subscriptions/:id ───────────────────────────────
// Handled via a separate [id] route — see route.ts in the [id] subdirectory.
