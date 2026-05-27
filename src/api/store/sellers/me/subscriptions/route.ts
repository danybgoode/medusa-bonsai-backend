/**
 * GET /store/sellers/me/subscriptions
 *
 * Returns all subscriber records for the authenticated seller.
 * Used by /shop/manage/subscriptions page.
 *
 * Auth: Clerk JWT in Authorization header.
 *
 * Query params:
 *   status  — filter by status (optional, comma-separated)
 *   plan_id — filter by plan (optional)
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SUBSCRIPTIONS_MODULE } from '../../../../../modules/subscriptions'
import SubscriptionsModuleService from '../../../../../modules/subscriptions/service'
import { resolveSeller } from '../../../_utils/clerk-auth'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const seller = await resolveSeller(req)
  if (!seller) return res.status(401).json({ message: 'Unauthorized' })

  const query = req.query as Record<string, string>
  const statusFilter = query.status?.split(',').filter(Boolean) ?? []
  const planId = query.plan_id ?? null

  const filters: Record<string, unknown> = { seller_id: seller.sellerId }
  if (statusFilter.length > 0) filters.status = statusFilter
  if (planId) filters.plan_id = planId

  const subsService: SubscriptionsModuleService = req.scope.resolve(SUBSCRIPTIONS_MODULE)
  const subscriptions = await (subsService as any).listSubscriptions(
    filters,
    { order: { created_at: 'DESC' }, take: 500 }
  ).catch(() => [])

  return res.json({ subscriptions })
}
