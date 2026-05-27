import { model } from '@medusajs/framework/utils'

/**
 * Subscription — a buyer's active recurring subscription.
 *
 * One record per buyer × plan. Lifecycle:
 *   pending  → active (payment confirmed)
 *   active   → past_due (payment failed)
 *   active   → canceled (buyer or seller cancels)
 *   past_due → active (payment retried successfully)
 *   past_due → canceled (payment permanently failed)
 */
const Subscription = model.define('subscription', {
  id: model.id({ prefix: 'sub' }).primaryKey(),

  // Subscription plan (tier)
  plan_id: model.text(),

  // Medusa customer ID (links to the buyer's Medusa Customer record)
  customer_id: model.text().nullable(),

  // Clerk user ID — primary buyer identity
  clerk_user_id: model.text().nullable(),

  // Buyer email (always set, even if buyer isn't registered)
  buyer_email: model.text(),

  // Subscription lifecycle status
  status: model.enum([
    'pending',           // payment initiated, not yet confirmed
    'active',            // payment confirmed, access granted
    'trialing',          // in free trial period
    'past_due',          // payment failed, access suspended
    'canceled',          // canceled by buyer or seller
    'pending_confirmation', // SPEI — awaiting seller confirmation
  ]).default('pending'),

  // Payment method used
  payment_method: model.enum(['stripe', 'mercadopago', 'spei', 'manual']).default('stripe'),

  // External IDs for payment reconciliation
  stripe_subscription_id: model.text().nullable(),
  stripe_customer_id: model.text().nullable(),
  mp_preapproval_id: model.text().nullable(),

  // Current billing period
  current_period_start: model.dateTime().nullable(),
  current_period_end: model.dateTime().nullable(),

  // Whether to cancel at end of current period
  cancel_at_period_end: model.boolean().default(false),

  // Seller ID (denormalized for fast queries)
  seller_id: model.text(),

  // Extra metadata (e.g. tier label snapshot for display)
  metadata: model.json().nullable(),
})

export default Subscription
