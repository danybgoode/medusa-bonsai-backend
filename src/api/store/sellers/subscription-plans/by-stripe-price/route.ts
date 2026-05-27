/**
 * GET /store/sellers/subscription-plans/by-stripe-price?stripe_price_id=xxx
 *
 * Finds a SubscriptionPlan by its Stripe Price ID.
 * Used by the Stripe webhook to correlate a checkout session with a Medusa plan.
 *
 * No auth required (read-only, non-sensitive lookup by webhook backend).
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SUBSCRIPTIONS_MODULE } from '../../../../../modules/subscriptions'
import SubscriptionsModuleService from '../../../../../modules/subscriptions/service'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const stripePriceId = req.query.stripe_price_id as string | undefined

  if (!stripePriceId) {
    return res.status(400).json({ message: 'stripe_price_id query param is required' })
  }

  const subsService: SubscriptionsModuleService = req.scope.resolve(SUBSCRIPTIONS_MODULE)

  const plans = await (subsService as any).listSubscriptionPlans(
    { stripe_price_id: stripePriceId },
    { take: 1 }
  ).catch(() => [])

  const plan = plans[0] ?? null

  if (!plan) {
    return res.status(404).json({ message: 'Plan not found' })
  }

  return res.json({ plan })
}
