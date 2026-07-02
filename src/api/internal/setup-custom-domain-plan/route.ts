/**
 * POST /internal/setup-custom-domain-plan
 *
 * Seed (idempotently) the ONE platform-owned SubscriptionPlan that backs the
 * custom-domain paywall SKU (epic 07 · custom-domain-paywall, Sprint 2).
 *
 * Unlike a seller's subscription tiers, this plan is owned by the PLATFORM
 * (`seller_id: 'platform'`) and the subscriber is the seller — the platform is
 * the payee (no 97% transfer). The Stripe Product + Price are created on the
 * frontend (it holds the Stripe lib) by `scripts/seed-custom-domain-plan.mjs`,
 * which then POSTs the resulting `stripe_price_id` here.
 *
 * Idempotent: re-running updates the existing plan's `stripe_price_id` /
 * `price_cents` rather than creating a duplicate. The plan is identified by
 * `seller_id: 'platform'` + `metadata.kind === 'custom_domain_plan'`.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SUBSCRIPTIONS_MODULE } from '../../../modules/subscriptions'
import type SubscriptionsModuleService from '../../../modules/subscriptions/service'

// Shared identifiers — keep in sync with the frontend
// (lib/domain-subscription.ts CUSTOM_DOMAIN_PLAN_KIND).
export const PLATFORM_SELLER_ID = 'platform'
export const CUSTOM_DOMAIN_PLAN_KIND = 'custom_domain_plan'
const DEFAULT_PRICE_CENTS = 49900 // $499 MXN / year

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const secret = req.headers['x-internal-secret']
  if (!secret || secret !== process.env.MEDUSA_INTERNAL_SECRET) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const body = (req.body ?? {}) as {
    stripe_price_id?: string
    price_cents?: number
    label?: string
  }

  if (!body.stripe_price_id) {
    return res.status(400).json({ message: 'stripe_price_id is required' })
  }

  const subs = req.scope.resolve(SUBSCRIPTIONS_MODULE) as SubscriptionsModuleService

  // Find an existing platform custom-domain plan (filter in JS — metadata
  // jsonb filters aren't reliably supported by the list query).
  const platformPlans: any[] = await (subs as any)
    .listSubscriptionPlans({ seller_id: PLATFORM_SELLER_ID }, { take: 100 })
    .catch(() => [])
  const existing = platformPlans.find(
    (p) => (p?.metadata as Record<string, unknown> | null)?.kind === CUSTOM_DOMAIN_PLAN_KIND,
  )

  const fields = {
    label: body.label ?? 'Dominio propio',
    description: 'Conecta tu propio dominio a tu tienda. $499 MXN/año.',
    price_cents: body.price_cents ?? DEFAULT_PRICE_CENTS,
    currency: 'mxn',
    interval: 'year' as const,
    stripe_price_id: body.stripe_price_id,
    is_active: true,
    metadata: { kind: CUSTOM_DOMAIN_PLAN_KIND },
  }

  let plan
  if (existing) {
    // `updateSubscriptionPlans` returns a SINGLE object for a by-id update (not an
    // array) — array-destructuring it throws "object is not iterable" on a re-seed
    // (create returns a single object used directly, so it worked; the result is
    // `subs as any`, invisible to tsc). Mirror the ml-sync fix (#54).
    const updated = await (subs as any).updateSubscriptionPlans({
      id: existing.id,
      ...fields,
    })
    plan = Array.isArray(updated) ? updated[0] : updated
  } else {
    plan = await (subs as any).createSubscriptionPlans({
      seller_id: PLATFORM_SELLER_ID,
      product_id: null,
      mp_plan_id: null,
      ...fields,
    })
  }

  return res.status(existing ? 200 : 201).json({ plan, created: !existing })
}
