/**
 * Find a seller by its connected Stripe account id.
 *
 * There is no JSON path index on the custom seller module, so this scan is
 * unavoidable. What IS avoidable is the shape it used to have — a flat
 * `listSellers({}, { take: 500 })` — which was a silent correctness cliff: at seller
 * 501 an `account.updated` webhook simply stops finding its seller and reports
 * `found: false`, indistinguishable from "that account isn't one of ours". A payment
 * readiness flag would then quietly stop tracking Stripe.
 *
 * Pure over an INJECTED page fetcher so the paging behaviour — including the
 * past-the-old-cap case that motivated it — is unit-testable without a database.
 */

export interface SellerLike {
  readonly id?: string
  readonly metadata?: unknown
}

/** One page of the scan. Small enough to be cheap, large enough to be few. */
export const SELLER_SCAN_PAGE = 200

/** Reads the connected account id off a seller row, tolerating any missing layer. */
export function sellerStripeAccountId(seller: SellerLike): string | null {
  const meta = (seller?.metadata ?? {}) as Record<string, unknown>
  const settings = (meta.settings ?? {}) as Record<string, unknown>
  const stripe = (settings.stripe ?? {}) as Record<string, unknown>
  return typeof stripe.account_id === 'string' && stripe.account_id ? stripe.account_id : null
}

export async function findSellerByStripeAccount<T extends SellerLike>(
  accountId: string,
  fetchPage: (skip: number, take: number) => Promise<T[]>,
  pageSize: number = SELLER_SCAN_PAGE,
): Promise<T | null> {
  // An empty/blank account id must never match a seller that simply has none stored.
  if (!accountId) return null

  for (let skip = 0; ; skip += pageSize) {
    const page = await fetchPage(skip, pageSize)
    if (page.length === 0) return null

    const hit = page.find((seller) => sellerStripeAccountId(seller) === accountId)
    if (hit) return hit

    // A short page is the last page; without this the loop would spin forever on a
    // fetcher that keeps returning the same trailing partial page.
    if (page.length < pageSize) return null
  }
}
