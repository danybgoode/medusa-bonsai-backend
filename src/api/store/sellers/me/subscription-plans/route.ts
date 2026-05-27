/**
 * GET  /store/sellers/me/subscription-plans  — list all plans for the authenticated seller
 * POST /store/sellers/me/subscription-plans  — create a new subscription plan (tier)
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SUBSCRIPTIONS_MODULE } from '../../../../../modules/subscriptions'
import SubscriptionsModuleService from '../../../../../modules/subscriptions/service'
import { resolveSeller } from '../../../_utils/clerk-auth'

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const seller = await resolveSeller(req)
  if (!seller) return res.status(401).json({ message: 'Unauthorized' })

  const subsService: SubscriptionsModuleService = req.scope.resolve(SUBSCRIPTIONS_MODULE)
  const plans = await (subsService as any).listSubscriptionPlans(
    { seller_id: seller.sellerId },
    { order: { created_at: 'DESC' } }
  ).catch(() => [])

  return res.json({ plans })
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const seller = await resolveSeller(req)
  if (!seller) return res.status(401).json({ message: 'Unauthorized' })

  const body = req.body as {
    product_id?: string
    label: string
    description?: string
    price_cents: number
    currency?: string
    interval?: 'month' | 'year'
    stripe_price_id?: string
    mp_plan_id?: string
    metadata?: Record<string, unknown>
  }

  if (!body.label || !body.price_cents) {
    return res.status(400).json({ message: 'label and price_cents are required' })
  }

  const subsService: SubscriptionsModuleService = req.scope.resolve(SUBSCRIPTIONS_MODULE)

  const plan = await (subsService as any).createSubscriptionPlans({
    seller_id: seller.sellerId,
    product_id: body.product_id ?? null,
    label: body.label,
    description: body.description ?? null,
    price_cents: body.price_cents,
    currency: body.currency ?? 'mxn',
    interval: body.interval ?? 'month',
    stripe_price_id: body.stripe_price_id ?? null,
    mp_plan_id: body.mp_plan_id ?? null,
    is_active: true,
    metadata: body.metadata ?? null,
  })

  return res.status(201).json({ plan })
}
