/**
 * POST /internal/setup-subdomain-plan
 *
 * Seed (idempotently) the ONE platform-owned SubscriptionPlan that backs the
 * subdomain paywall SKU (epic 07 · subdomain-pricing, Sprint 2). A faithful clone
 * of `/internal/setup-custom-domain-plan` onto the cheaper subdomain SKU.
 *
 * Like the custom-domain plan, this plan is owned by the PLATFORM
 * (`seller_id: 'platform'`) and the subscriber is the seller — the platform is the
 * payee (no 97% transfer). The Stripe Product + Price are created on the frontend
 * (it holds the Stripe lib) by `scripts/seed-subdomain-plan.mjs`, which then POSTs
 * the resulting `stripe_price_id` here.
 *
 * Idempotent: re-running updates the existing plan's `stripe_price_id` /
 * `price_cents` rather than creating a duplicate. The plan is identified by
 * `seller_id: 'platform'` + `metadata.kind === 'subdomain_plan'` — a DISTINCT kind
 * from the custom-domain plan, so the two SKUs never collide on the shared
 * subscription_plan table (no schema migration: pure metadata discriminator).
 *
 * Cadence (epic 07 · Sprint 3): the SAME plan carries BOTH the yearly and monthly
 * recurring prices — one plan so the entitlement read + the proration-based
 * monthly↔yearly switch stay trivially correct.
 *   - `interval: 'year'` (default) — the plan's `stripe_price_id` column ($199/yr).
 *   - `interval: 'month'` — the $25/mo price, stored in `metadata.monthly_stripe_price_id`
 *     + `metadata.monthly_price_cents` (the column holds the yearly one). Seed the
 *     yearly plan first; the monthly POST then merges onto it.
 * Both POSTs merge (never clobber) the other cadence's fields, so re-seeding either
 * one is idempotent.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SUBSCRIPTIONS_MODULE } from '../../../modules/subscriptions'
import type SubscriptionsModuleService from '../../../modules/subscriptions/service'
import { PLATFORM_SELLER_ID } from '../setup-custom-domain-plan/route'

// Shared identifier — keep in sync with the frontend
// (lib/subdomain-subscription.ts / lib/subdomain-pricing.ts).
export const SUBDOMAIN_PLAN_KIND = 'subdomain_plan'
const DEFAULT_PRICE_CENTS = 19900 // $199 MXN / year
const DEFAULT_MONTHLY_CENTS = 2500 // $25 MXN / month

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const secret = req.headers['x-internal-secret']
  if (!secret || secret !== process.env.MEDUSA_INTERNAL_SECRET) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const body = (req.body ?? {}) as {
    stripe_price_id?: string
    price_cents?: number
    label?: string
    interval?: string
  }

  if (!body.stripe_price_id) {
    return res.status(400).json({ message: 'stripe_price_id is required' })
  }
  const interval = body.interval === 'month' ? 'month' : 'year'

  const subs = req.scope.resolve(SUBSCRIPTIONS_MODULE) as SubscriptionsModuleService

  // Find an existing platform subdomain plan (filter in JS — metadata jsonb
  // filters aren't reliably supported by the list query).
  const platformPlans: any[] = await (subs as any)
    .listSubscriptionPlans({ seller_id: PLATFORM_SELLER_ID }, { take: 100 })
    .catch(() => [])
  const existing = platformPlans.find(
    (p) => (p?.metadata as Record<string, unknown> | null)?.kind === SUBDOMAIN_PLAN_KIND,
  )
  const prevMeta = (existing?.metadata ?? {}) as Record<string, unknown>

  // ── Monthly cadence (Sprint 3): a second recurring price on the SAME plan, held
  // in metadata (the column stays the yearly one). Requires the yearly plan to
  // exist first (the seed order guarantees it).
  if (interval === 'month') {
    if (!existing) {
      return res
        .status(400)
        .json({ message: 'Seed the yearly subdomain plan first (interval=year), then the monthly one.' })
    }
    const [plan] = await (subs as any).updateSubscriptionPlans({
      id: existing.id,
      metadata: {
        ...prevMeta,
        kind: SUBDOMAIN_PLAN_KIND,
        monthly_stripe_price_id: body.stripe_price_id,
        monthly_price_cents: body.price_cents ?? DEFAULT_MONTHLY_CENTS,
      },
    })
    return res.status(200).json({ plan, created: false })
  }

  // ── Yearly cadence (default) — the plan's stripe_price_id column. Merge the
  // existing metadata so a re-seed never drops the monthly fields.
  const fields = {
    label: body.label ?? 'Subdominio propio',
    description: 'Tu tienda en tu-tienda.miyagisanchez.com (sitio independiente). $199 MXN/año.',
    price_cents: body.price_cents ?? DEFAULT_PRICE_CENTS,
    currency: 'mxn',
    interval: 'year' as const,
    stripe_price_id: body.stripe_price_id,
    is_active: true,
    metadata: { ...prevMeta, kind: SUBDOMAIN_PLAN_KIND },
  }

  let plan
  if (existing) {
    ;[plan] = await (subs as any).updateSubscriptionPlans({
      id: existing.id,
      ...fields,
    })
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
