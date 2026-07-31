/**
 * Pure precondition planner for the operating-channel backfill (owned-shop-operating-
 * channel epic, S1.4) — the sibling of `market-backfill.ts`, reusing its shape
 * (validate-before-apply, capped-scan refusal, per-seller market scoping) with the
 * TWO deliberate deviations the epic README locks in:
 *
 *   D6 — every product status is scanned, not only `published`. A draft left out of
 *        the operating channel becomes unbuyable the moment it is published, which
 *        is a bug that surfaces long after this epic closed. Linking a draft is
 *        inert: `/store/products` filters `status` independently of channel
 *        membership.
 *   D5 — the stock-location ↔ sales-channel graph is part of this report (see
 *        `stock-location-graph.ts`), because Medusa reserves inventory at order
 *        completion against the CART'S channel, and the operating channel carries no
 *        stock-location link by default.
 *
 * This route never stamps `seller.metadata.operating_market` — the market-backfill
 * route (parent epic) already did that and D1 measured 0 unclassifiable sellers. This
 * planner only classifies EXISTING seller state to decide which market's operating
 * channel a product belongs to; an unclassifiable seller blocks apply exactly like
 * market-backfill's `seller_plan.abort` does, just under its own name since there is
 * no "would_set" here — there is nothing to write to the seller row.
 */

import type { MedusaIdResolution } from '../../../lib/market-medusa'
import type { MarketplaceLinkPlan } from '../../../lib/seller-market'
import type { ScanWindow } from './scan-window'
import type { OwnershipScanFailure } from './market-backfill'

export interface UnclassifiableSeller {
  readonly seller_id: string
  readonly raw: unknown
}

export interface OperatingChannelBackfillPreconditions {
  readonly channel: MedusaIdResolution
  readonly channel_exists: boolean
  readonly seller_scan: ScanWindow
  readonly product_scan: ScanWindow
  readonly ownership_scan_failures: readonly OwnershipScanFailure[]
  readonly unclassifiable_sellers: readonly UnclassifiableSeller[]
  readonly link_plan: Pick<MarketplaceLinkPlan, 'skipped_unowned'> | null
}

/**
 * Every reason the apply must refuse, returned together so an operator can repair
 * the whole population before retrying — the exact rule `market-backfill.ts` learned
 * from a cross-review (validate every precondition, all at once, before the first
 * write).
 */
export function operatingChannelBackfillBlockingReasons(
  state: OperatingChannelBackfillPreconditions,
): string[] {
  const reasons: string[] = []

  if (state.channel.status !== 'resolved') {
    reasons.push(
      state.channel.status === 'unconfigured'
        ? state.channel.reason
        : `This market has no operating channel: ${state.channel.reason}`,
    )
  } else if (!state.channel_exists) {
    reasons.push(
      `The configured operating channel id "${state.channel.id}" does not exist in this database. ` +
      'Refusing the whole run: linking products against a stale id would leave a half-applied backfill.',
    )
  }

  if (!state.seller_scan.complete) reasons.push(state.seller_scan.reason!)
  if (!state.product_scan.complete) reasons.push(state.product_scan.reason!)

  if (state.unclassifiable_sellers.length > 0) {
    const ids = state.unclassifiable_sellers.map((s) => s.seller_id).join(', ')
    reasons.push(
      `At least one seller carries an unrecognised operating_market (${ids}). A row we cannot ` +
      'classify is a row whose products we must not link to any market\'s operating channel.',
    )
  }

  if (state.ownership_scan_failures.length > 0) {
    const sellers = state.ownership_scan_failures.map((failure) => failure.seller_id).join(', ')
    reasons.push(
      `Could not determine product ownership for ${state.ownership_scan_failures.length} seller(s) ` +
      `(${sellers}). Refusing to treat an unavailable ownership read as an empty catalog.`,
    )
  }

  if (state.link_plan && state.link_plan.skipped_unowned.length > 0) {
    reasons.push(
      `${state.link_plan.skipped_unowned.length} product(s) have no resolvable owner. Repair those ` +
      'product↔seller links before applying the backfill.',
    )
  }

  return reasons
}

/** A product row carrying (at least) the field D6's split reports on. */
export interface ProductStatusRow {
  readonly id: string
  readonly status?: string | null
}

export interface PublishedDraftSplit<T> {
  readonly published: T[]
  readonly draft: T[]
}

/**
 * D6 — report the published/draft split rather than a single count, so the reviewer
 * can see that this backfill is NOT scoped to `published` the way the marketplace
 * backfill is. "Draft" here is every non-`published` status (Medusa also has
 * `proposed` and `rejected`) — collapsed into one bucket because the distinction
 * this report exists to surface is "does the storefront show this today", and only
 * `published` does; every other status is equally "not yet, but soon buyable".
 */
export function splitByPublished<T extends ProductStatusRow>(
  products: readonly T[],
): PublishedDraftSplit<T> {
  const published: T[] = []
  const draft: T[] = []
  for (const product of products) {
    if (product.status === 'published') published.push(product)
    else draft.push(product)
  }
  return { published, draft }
}
