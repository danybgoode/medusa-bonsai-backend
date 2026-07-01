import { model } from '@medusajs/framework/utils'

/**
 * MlSyncEvent — an append-only, per-seller activity log for the Mercado Libre
 * integration (Sprint 5 · US-13). One row per meaningful sync action: a publish,
 * a close, an outbound stock push, an applied ML sale, a reconcile pass, an
 * import, or a token-refresh failure that needs re-auth.
 *
 * Why it lives in the ML **Medusa module** (not Supabase): the events that matter
 * most — outbound stock pushes, applied ML sales, reconcile passes, token-refresh
 * failures — originate **entirely in the backend** (a subscriber, a webhook, a
 * cron job) with no frontend involvement, and this module is deliberately
 * Supabase-free. Co-locating the log with the sync core (the token, the linkage,
 * the inventory writes) is the same rationale that keeps the tokens here.
 *
 * Strictly observability: it is NEVER read to make a sync decision (the linkage
 * metadata + the dedupe ring own correctness), so an append failure is swallowed
 * and can never break a sync. `message` is short + redacted — never a stack trace,
 * never a token (see `summarizeSyncEvent` in `_utils.ts`).
 */
const MlSyncEvent = model
  .define('ml_sync_event', {
    id: model.id({ prefix: 'mlse' }).primaryKey(),
    // The Medusa seller id this event belongs to (the per-seller scope).
    seller_id: model.text(),
    // The Medusa product involved, when the event is product-scoped (nullable for
    // connection-level events like a token-refresh failure or a reconcile summary).
    product_id: model.text().nullable(),
    ml_item_id: model.text().nullable(),
    // Free-text kind (validated by `summarizeSyncEvent`, not a DB enum, so adding a
    // new event kind never needs a migration): token_refresh | publish | close |
    // stock_push | sale_applied | reconcile | import.
    kind: model.text(),
    // 'ok' | 'fail'.
    outcome: model.text(),
    // A stable machine code (e.g. ML_REAUTH_REQUIRED, the publish action, 'deferred').
    code: model.text().nullable(),
    // Short, human-legible, es-MX-friendly summary — capped + redacted at write time.
    message: model.text().nullable(),
    // Small structured extras (units, available qty, counts) — never secrets.
    metadata: model.json().nullable(),
  })
  .indexes([
    // The one query this table serves: "recent events for a seller, newest first".
    { on: ['seller_id', 'created_at'] },
  ])

export default MlSyncEvent
