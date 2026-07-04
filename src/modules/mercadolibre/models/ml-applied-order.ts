import { model } from '@medusajs/framework/utils'

/**
 * MlAppliedOrder — the durable, exactly-once ledger for "has this ML order's sale
 * already been applied to this link." Supersedes the capped 500-entry ring that
 * used to live on `product_ml_link.metadata.ml_applied_orders` (Sprint 4): a ring
 * evicts its oldest entries past the cap, so a very-delayed reconcile replay could
 * theoretically re-apply a decrement the ring had forgotten. A DB row with a
 * `unique(link_id, ml_order_id)` constraint has no eviction — it is the actual
 * exactly-once primitive, not an approximation of one (US-0, absorbing ml-sync
 * S5's deferred US-15).
 *
 * One row per (link, ML order): `inventory_delta` records what the stock
 * decrement actually was (audit — the delta may be less than sold qty if
 * available was already low, see `safeDecrement`); `medusa_order_id` is set only
 * when `ml.orders_enabled` was on at apply time (null under the flag-off path —
 * "today's behavior exactly"). Both the decrement and the order-materialization
 * write into this row inside the SAME Redis lock `applyMlOrderToLink` already
 * holds per link, so a crash mid-apply can't leave a half-applied order.
 *
 * `cancelled_at` (ml-orders-native S2 · US-4): stamped once an ML
 * cancellation/refund has been reflected — a restock of exactly `inventory_delta`
 * units plus a Medusa order cancel. Its presence is the exactly-once guarantee for
 * the reverse direction (`decideMlOrderCancel`): a replayed cancel notification
 * sees it already set and is a no-op, mirroring how `medusa_order_id` already
 * guards the forward apply direction.
 */
const MlAppliedOrder = model
  .define('ml_applied_order', {
    id: model.id({ prefix: 'mlao' }).primaryKey(),
    link_id: model.text(),
    ml_order_id: model.text(),
    medusa_order_id: model.text().nullable(),
    inventory_delta: model.number(),
    applied_at: model.dateTime(),
    cancelled_at: model.dateTime().nullable(),
  })
  .indexes([
    // The exactly-once constraint itself — defense in depth behind the Redis lock
    // (a lock-service outage or a split-brain write must still not double-apply).
    { on: ['link_id', 'ml_order_id'], unique: true, where: 'deleted_at IS NULL' },
  ])

export default MlAppliedOrder
