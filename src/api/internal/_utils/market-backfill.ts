/**
 * Pure precondition planner for the market backfill.
 *
 * The route deliberately gathers all state before it writes anything. Keeping the
 * verdict here makes the GET preview and POST apply use the exact same rules, and
 * lets the dangerous branches (stale channel id, truncated scans, failed ownership
 * reads) run under unit tests without a Medusa container or database.
 */

import type { MedusaIdResolution } from '../../../lib/market-medusa'
import type {
  MarketplaceLinkPlan,
  SellerMarketBackfillPlan,
} from '../../../lib/seller-market'
import type { ScanWindow } from './scan-window'

export interface OwnershipScanFailure {
  readonly seller_id: string
  readonly reason: string
}

export interface MarketBackfillPreconditions {
  readonly channel: MedusaIdResolution
  readonly channel_exists: boolean
  readonly seller_plan: Pick<SellerMarketBackfillPlan, 'abort'>
  readonly seller_scan: ScanWindow
  readonly product_scan: ScanWindow
  readonly ownership_scan_failures: readonly OwnershipScanFailure[]
  readonly link_plan: Pick<MarketplaceLinkPlan, 'skipped_unowned'> | null
}

/**
 * Every reason the apply must refuse, returned together so an operator can repair
 * the whole population before retrying.
 */
export function marketBackfillBlockingReasons(
  state: MarketBackfillPreconditions,
): string[] {
  const reasons: string[] = []

  if (state.channel.status !== 'resolved') {
    reasons.push(
      state.channel.status === 'unconfigured'
        ? state.channel.reason
        : `This market has no marketplace channel: ${state.channel.reason}`,
    )
  } else if (!state.channel_exists) {
    reasons.push(
      `MEDUSA_SALES_CHANNEL_ID points at "${state.channel.id}", which does not exist in this database. ` +
      'Refusing the whole run: stamping sellers and then failing on the product link would leave a ' +
      'half-applied backfill.',
    )
  }

  if (state.seller_plan.abort) {
    reasons.push('At least one seller carries an unrecognised operating_market. Repair those rows first.')
  }
  if (!state.seller_scan.complete) reasons.push(state.seller_scan.reason!)
  if (!state.product_scan.complete) reasons.push(state.product_scan.reason!)

  if (state.ownership_scan_failures.length > 0) {
    const sellers = state.ownership_scan_failures.map((failure) => failure.seller_id).join(', ')
    reasons.push(
      `Could not determine product ownership for ${state.ownership_scan_failures.length} seller(s) ` +
      `(${sellers}). Refusing to treat an unavailable ownership read as an empty catalog.`,
    )
  }

  if (state.link_plan && state.link_plan.skipped_unowned.length > 0) {
    reasons.push(
      `${state.link_plan.skipped_unowned.length} published product(s) missing the marketplace channel ` +
      'have no resolvable owner. Repair those product links before applying the backfill.',
    )
  }

  return reasons
}

export interface SqlExecutor {
  raw: (sql: string, bindings: readonly unknown[]) => Promise<{ rows?: unknown[]; rowCount?: number }>
}

/**
 * Stamp only the missing JSON key in one atomic UPDATE. The WHERE predicate and
 * jsonb_set execute under the same row lock, so a concurrent metadata write is
 * preserved and a concurrent market stamp wins without being overwritten.
 */
export async function stampSellerMarketIfAbsent(
  db: SqlExecutor,
  sellerId: string,
  market: string,
): Promise<'updated' | 'skipped'> {
  const result = await db.raw(
    `UPDATE seller
       SET metadata = jsonb_set(
         CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END,
         '{operating_market}',
         to_jsonb(?::text),
         true
       ),
       updated_at = now()
     WHERE id = ?
       AND deleted_at IS NULL
       AND btrim(coalesce(metadata->>'operating_market', '')) = ''
     RETURNING id`,
    [market, sellerId],
  )
  const changed = result.rowCount ?? result.rows?.length ?? 0
  return changed > 0 ? 'updated' : 'skipped'
}
