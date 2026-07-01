/**
 * POST /internal/setup-ml-sync-plan
 *
 * Seed (idempotently) the ONE platform-owned SubscriptionPlan that backs the
 * Mercado Libre sync paid SKU (epic 03 · mercadolibre-sync, Sprint 6). A faithful
 * clone of `/internal/setup-subdomain-plan` onto the ML-sync SKU.
 *
 * Like the subdomain plan, this plan is owned by the PLATFORM
 * (`seller_id: 'platform'`) and the subscriber is the seller — the platform is the
 * payee (no 97% transfer). The Stripe Product + Price are created on the frontend
 * (it holds the Stripe lib) by `scripts/seed-ml-sync-plan.mjs`, which then POSTs the
 * resulting `stripe_price_id` here.
 *
 * Idempotent: re-running updates the existing plan's price rather than creating a
 * duplicate. The plan is identified by `seller_id: 'platform'` + `metadata.kind ===
 * 'ml_sync_plan'` — a DISTINCT kind from custom-domain / subdomain, so the SKUs
 * never collide on the shared subscription_plan table (no migration: metadata
 * discriminator).
 *
 * Cadence: the SAME plan carries BOTH the yearly and monthly recurring prices —
 * one plan so the entitlement read stays trivially correct.
 *   - `interval: 'year'` (default) — the plan's `stripe_price_id` column ($299/yr).
 *   - `interval: 'month'` — the $30/mo price, stored in `metadata.monthly_stripe_price_id`
 *     + `metadata.monthly_price_cents`. Seed the yearly plan first; the monthly POST
 *     merges onto it. Both POSTs merge (never clobber) the other cadence's fields.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SUBSCRIPTIONS_MODULE } from '../../../modules/subscriptions'
import type SubscriptionsModuleService from '../../../modules/subscriptions/service'
import { PLATFORM_SELLER_ID } from '../setup-custom-domain-plan/route'

// Shared identifier — keep in sync with the frontend
// (lib/ml-sync-subscription.ts / lib/ml-sync-pricing.ts).
export const ML_SYNC_PLAN_KIND = 'ml_sync_plan'
const DEFAULT_PRICE_CENTS = 29900 // $299 MXN / year
const DEFAULT_MONTHLY_CENTS = 3000 // $30 MXN / month

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

  // Find an existing platform ML-sync plan (filter in JS — metadata jsonb filters
  // aren't reliably supported by the list query).
  const platformPlans: any[] = await (subs as any)
    .listSubscriptionPlans({ seller_id: PLATFORM_SELLER_ID }, { take: 100 })
    .catch(() => [])
  const existing = platformPlans.find(
    (p) => (p?.metadata as Record<string, unknown> | null)?.kind === ML_SYNC_PLAN_KIND,
  )
  const prevMeta = (existing?.metadata ?? {}) as Record<string, unknown>

  // ── Monthly cadence: a second recurring price on the SAME plan, held in metadata
  // (the column stays the yearly one). Requires the yearly plan to exist first.
  if (interval === 'month') {
    if (!existing) {
      return res
        .status(400)
        .json({ message: 'Seed the yearly ML-sync plan first (interval=year), then the monthly one.' })
    }
    const updatedMonthly = await (subs as any).updateSubscriptionPlans({
      id: existing.id,
      metadata: {
        ...prevMeta,
        kind: ML_SYNC_PLAN_KIND,
        monthly_stripe_price_id: body.stripe_price_id,
        monthly_price_cents: body.price_cents ?? DEFAULT_MONTHLY_CENTS,
      },
    })
    // `updateSubscriptionPlans` returns a SINGLE object for a by-id update (not an
    // array) — array-destructuring it throws "object is not iterable". Normalize
    // either shape (the connect path uses the same Array.isArray guard).
    const plan = Array.isArray(updatedMonthly) ? updatedMonthly[0] : updatedMonthly
    return res.status(200).json({ plan, created: false })
  }

  // ── Yearly cadence (default) — the plan's stripe_price_id column. Merge the
  // existing metadata so a re-seed never drops the monthly fields.
  const fields = {
    label: body.label ?? 'Sincronización Mercado Libre',
    description: 'Sincronización de inventario entre Mercado Libre y Miyagi. $299 MXN/año.',
    price_cents: body.price_cents ?? DEFAULT_PRICE_CENTS,
    currency: 'mxn',
    interval: 'year' as const,
    stripe_price_id: body.stripe_price_id,
    is_active: true,
    metadata: { ...prevMeta, kind: ML_SYNC_PLAN_KIND },
  }

  let plan
  if (existing) {
    // Normalize the single-object return (see the monthly branch above).
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
