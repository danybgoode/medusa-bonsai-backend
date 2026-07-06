import { model } from '@medusajs/framework/utils'

/**
 * FinancialEvent — the append-only per-order-line financial ledger
 * (profit-analyzer S1 · US-2). One row per financial fact about a sale,
 * frozen at capture time: revenue, marketplace fee, shipping cost, COGS
 * snapshot. Historical margins stay true when fees or the seller's costs
 * change later BECAUSE rows are never mutated — a correction or a
 * late-arriving piece (a label bought after the sale) lands as a NEW event,
 * never an UPDATE. The migration enforces this with a Postgres trigger that
 * raises on UPDATE/DELETE (belt), and the service only exposes append/list
 * (suspenders) — see `appendFinancialEvents`.
 *
 * Exactly-once: `dedupe_key` is deterministic
 * (`order:line:event_type[:qualifier]`, built by `buildLedgerDedupeKey` in
 * `src/lib/profit-ledger.ts`), unique where `deleted_at IS NULL` — replaying
 * the source event (webhook redelivery, reconcile pass, backfill re-run)
 * regenerates the identical key and writes nothing new. Same primitive as
 * `ml_applied_order`'s unique(link_id, ml_order_id).
 *
 * `amount_cents` is ALWAYS integer centavos MXN-side (ML raw payloads carry
 * decimal pesos — the parser converts; native Medusa amounts are already
 * centavos platform-wide). `metadata` records provenance (which raw field a
 * defensively-parsed ML amount came from) so the sandbox eyeball owed to
 * Daniel can verify field semantics without a schema change.
 */
const FinancialEvent = model
  .define('financial_event', {
    id: model.id({ prefix: 'fev' }).primaryKey(),
    /** Medusa order id (both native and ML-materialized orders). */
    order_id: model.text(),
    /** Medusa order line item id; null for order-level events (e.g. shipping). */
    order_line_id: model.text().nullable(),
    /** Medusa seller id (seller module) — the margin dashboard's read key. */
    seller_id: model.text().nullable(),
    /** Where the sale happened: 'mercadolibre' | 'native'. */
    source: model.text(),
    /** 'revenue' | 'ml_fee' | 'shipping_cost' | 'cogs_snapshot'. */
    event_type: model.text(),
    /** Integer centavos. Costs/fees are stored POSITIVE; event_type carries the sign semantics. */
    amount_cents: model.number(),
    currency_code: model.text(),
    /** Deterministic idempotency key — see buildLedgerDedupeKey. */
    dedupe_key: model.text(),
    /** When the underlying fact was captured (sale time / label purchase time). */
    captured_at: model.dateTime(),
    /** Provenance: raw source fields, parse assumptions, quantities. */
    metadata: model.json().nullable(),
  })
  .indexes([
    // The append-only ledger's exactly-once constraint.
    { on: ['dedupe_key'], unique: true, where: 'deleted_at IS NULL' },
    // The dashboard's two hot read keys.
    { on: ['seller_id'] },
    { on: ['order_id'] },
  ])

export default FinancialEvent
