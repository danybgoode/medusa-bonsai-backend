/**
 * PATCH /store/customers/me/subscriptions/:id
 *
 * Update a subscription — primarily used to cancel at period end or immediately.
 *
 * Body: { cancel_at_period_end?: boolean; status?: 'canceled' }
 *
 * Auth: Clerk JWT in Authorization header.
 * Security: validates that the subscription belongs to the authenticated buyer.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SUBSCRIPTIONS_MODULE } from '../../../../../../modules/subscriptions'
import SubscriptionsModuleService from '../../../../../../modules/subscriptions/service'
import { extractClerkUserId } from '../../../../_utils/clerk-auth'

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return res.status(401).json({ message: 'Unauthorized' })

  const { id } = req.params
  const body = req.body as {
    cancel_at_period_end?: boolean
    status?: string
  }

  const subsService: SubscriptionsModuleService = req.scope.resolve(SUBSCRIPTIONS_MODULE)

  // Verify ownership
  let subscription: any = null
  try {
    const [sub] = await (subsService as any).listSubscriptions(
      { id, clerk_user_id: clerkUserId },
      { take: 1 }
    )
    subscription = sub ?? null
  } catch { /* fall through to 404 */ }

  if (!subscription) {
    return res.status(404).json({ message: 'Subscription not found' })
  }

  // Apply updates
  const updates: Record<string, unknown> = {}
  if (typeof body.cancel_at_period_end === 'boolean') {
    updates.cancel_at_period_end = body.cancel_at_period_end
  }
  if (body.status === 'canceled') {
    updates.status = 'canceled'
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ message: 'No valid updates provided' })
  }

  const updated = await (subsService as any).updateSubscriptions(id, updates)

  return res.json({ subscription: updated })
}
