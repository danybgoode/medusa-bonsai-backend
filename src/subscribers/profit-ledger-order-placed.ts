/**
 * Profit ledger · native sales write point (profit-analyzer S1 · US-2).
 *
 * `order.placed` is the guaranteed exactly-once "a sale happened" signal
 * (same reasoning as `ml-inventory-sync`). Only NATIVE orders arrive here —
 * ML-materialized orders compose `createOrdersStep` directly, which emits no
 * events; their ledger write point is `applyMlOrderToLink` (post-lock). The
 * composer double-guards on `metadata.source` anyway.
 *
 * Best-effort + flag-gated inside `appendOrderLedger`: a ledger hiccup never
 * affects order placement, and with `ops.profit_enabled` OFF this is a no-op
 * (the backfill route heals the gap if the flag comes on later).
 */

import type { SubscriberArgs, SubscriberConfig } from '@medusajs/framework'
import { appendOrderLedger } from '../lib/profit-ledger-write'

export default async function profitLedgerOrderPlaced({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  await appendOrderLedger(container as never, data.id)
}

export const config: SubscriberConfig = {
  event: 'order.placed',
}
