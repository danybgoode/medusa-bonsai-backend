import { MedusaService } from '@medusajs/framework/utils'
import FinancialEvent from './models/financial-event'
import { isUniqueViolationError } from '../mercadolibre/sync-utils'
import { filterNewLedgerEvents, type LedgerEventInput } from '../../lib/profit-ledger'

/**
 * Profit module service (profit-analyzer S1 · US-2).
 *
 * The ONLY write surface this codebase uses on `financial_event` is
 * `appendFinancialEvents` — append + list, never update/delete. The
 * auto-generated `updateFinancialEvents`/`deleteFinancialEvents` from
 * MedusaService still exist on the prototype, but the migration's Postgres
 * trigger raises on any UPDATE/DELETE, so even a future code path that
 * reaches for them fails loudly instead of silently rewriting history.
 */
class ProfitModuleService extends MedusaService({ FinancialEvent }) {
  /**
   * Append ledger events exactly-once. Pre-filters against already-persisted
   * `dedupe_key`s (cheap replay no-op), then inserts one-by-one tolerating
   * unique violations (two concurrent writers racing the same event — the
   * constraint, not the pre-filter, is the guarantee). Never throws on a
   * duplicate; rethrows anything else.
   */
  async appendFinancialEvents(
    events: LedgerEventInput[],
  ): Promise<{ appended: number; skipped: number }> {
    if (events.length === 0) return { appended: 0, skipped: 0 }

    const existing = await this.listFinancialEvents(
      { dedupe_key: events.map((e) => e.dedupe_key) },
      { select: ['dedupe_key'], take: events.length },
    )
    const existingKeys = new Set(existing.map((r: { dedupe_key: string }) => r.dedupe_key))
    const fresh = filterNewLedgerEvents(existingKeys, events)

    let appended = 0
    for (const event of fresh) {
      try {
        await this.createFinancialEvents(event)
        appended += 1
      } catch (e) {
        if (!isUniqueViolationError(e)) throw e
        // Lost a race to a concurrent writer — the row exists, which is the goal.
      }
    }
    return { appended, skipped: events.length - appended }
  }
}

export default ProfitModuleService
