import { model } from '@medusajs/framework/utils'

/**
 * SubscriptionPlan — a single recurring-billing tier.
 *
 * A seller can create multiple plans per listing (e.g. Basic $199/mo, Pro $499/mo).
 * Each plan maps to exactly one Stripe Price ID and, if the seller uses MP, one
 * MercadoPago PreApprovalPlan ID.
 */
const SubscriptionPlan = model.define('subscription_plan', {
  id: model.id({ prefix: 'subplan' }).primaryKey(),

  // The Medusa seller who owns this plan
  seller_id: model.text(),

  // Medusa product ID of the subscription listing
  product_id: model.text().nullable(),

  // Human-readable label visible to buyers (e.g. "Plan Básico", "Plan Pro")
  label: model.text(),

  // Description / bullet points shown to buyers
  description: model.text().nullable(),

  // Price in the smallest currency unit (centavos for MXN)
  price_cents: model.number(),

  // ISO 4217 currency code, lowercase (e.g. 'mxn')
  currency: model.text().default('mxn'),

  // Billing frequency
  interval: model.enum(['month', 'year']).default('month'),

  // Stripe Price ID on the platform account
  stripe_price_id: model.text().nullable(),

  // MercadoPago PreApprovalPlan ID
  mp_plan_id: model.text().nullable(),

  // Whether this plan is accepting new subscribers
  is_active: model.boolean().default(true),

  // Extra metadata (e.g. perks list, tier color, etc.)
  metadata: model.json().nullable(),
})

export default SubscriptionPlan
