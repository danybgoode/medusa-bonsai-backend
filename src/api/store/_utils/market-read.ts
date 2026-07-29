/**
 * market-read.ts — the marketplace READ boundary: which products a country
 * marketplace is allowed to return.
 *
 * ⚠️ THIS IS NEW ENFORCEMENT, NOT A REPAIR (epic README, D1). Before this file,
 * `GET /store/listings`, `/store/listings/:id`, search and category all ran
 * `remoteQuery.graph({ entity: 'product', filters: { status: 'published' } })` with
 * NO Sales Channel constraint at all. Switching this on can therefore HIDE a product
 * that is visible today — which is why the dry-run report
 * (`GET /internal/market-backfill`) publishes the count of published products with no
 * MX marketplace-channel link, and that count is reviewed before this ships.
 *
 * WHAT THIS BOUNDARY IS NOT: it is not an owned-shop filter. `/store/sellers/:slug/
 * products` and every tenant-channel read (subdomain, custom domain, embed) resolve
 * by SELLER OWNERSHIP + PUBLISH STATE and must never call into here (D4). A shop
 * existing and a shop being admitted to a country marketplace are independent facts;
 * conflating them is the exact failure this epic exists to prevent. The deterministic
 * proof lives in `market-read.unit.spec.ts`: owned-visible + no channel membership ⇒
 * present on the owned shop, absent from the `mx` marketplace query.
 */

import {
  DEFAULT_MARKET,
  type MarketCode,
  type MarketplaceStatus,
  MARKETS,
  UnknownMarketError,
  isMarketplaceOpen,
  requireMarket,
} from '../../../lib/markets'
import {
  type MarketMedusaEnv,
  resolveMarketplaceChannelForMarket,
} from '../../../lib/market-medusa'

/** The structured body every closed gate returns. Never an empty success. */
export interface MarketUnavailableBody {
  readonly unavailable: true
  readonly market_code: string | null
  readonly marketplace_status: MarketplaceStatus | null
  readonly reason: string
}

/**
 * The decision a marketplace read route makes before it queries anything.
 *
 * Four outcomes, all named, because "return nothing" has three completely different
 * causes and a caller (especially an agent) must be able to tell them apart:
 *
 *   open        — proceed, filtering by `channel_id`.
 *   unknown     — 400. The caller asked for a market that does not exist.
 *   closed      — 404. The market exists but its marketplace is `invitation`
 *                 (`us`). Structurally has no catalog — never another market's rows.
 *   unavailable — 503. The market IS open but its channel cannot be addressed
 *                 (`MEDUSA_SALES_CHANNEL_ID` unset). This is an operator fault, and
 *                 it fails CLOSED and loudly rather than serving the unfiltered
 *                 catalog: an unfiltered answer here is indistinguishable from a
 *                 correct one, which is how a boundary silently stops existing.
 */
export type MarketReadGate =
  | { readonly ok: true; readonly market: MarketCode; readonly channel_id: string }
  | { readonly ok: false; readonly kind: 'unknown' | 'closed' | 'unavailable'; readonly status: number; readonly body: MarketUnavailableBody }

/**
 * Normalise the `?market=` query parameter.
 *
 * Absent/empty ⇒ `DEFAULT_MARKET`. That default is the pre-launch compatibility
 * window only: every existing storefront and agent call predates the parameter and
 * was written against a single Mexico marketplace. A PRESENT-but-unrecognised value
 * is never defaulted — it is a caller error and gets an explicit failure, because
 * silently answering `mx` for `?market=us` is precisely the leak this boundary
 * exists to stop.
 */
export function resolveRequestedMarket(raw: unknown): MarketCode | { error: UnknownMarketError } {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return DEFAULT_MARKET
  }
  try {
    // Reuse the registry's own error, including its "that looks like a LOCALE" hint
    // (D3). Re-deriving the message here would fork the contract — a paraphrased
    // rule drifts permissive.
    return requireMarket(raw).code
  } catch (e) {
    return { error: e as UnknownMarketError }
  }
}

/** Decide whether a marketplace read may proceed, and against which channel. */
export function resolveMarketReadGate(raw: unknown, env: MarketMedusaEnv): MarketReadGate {
  const requested = resolveRequestedMarket(raw)
  if (typeof requested !== 'string') {
    return {
      ok: false,
      kind: 'unknown',
      status: 400,
      body: {
        unavailable: true,
        market_code: typeof raw === 'string' ? raw : null,
        marketplace_status: null,
        reason: requested.error.message,
      },
    }
  }

  const record = MARKETS[requested]
  if (!isMarketplaceOpen(requested)) {
    return {
      ok: false,
      kind: 'closed',
      status: 404,
      body: {
        unavailable: true,
        market_code: record.code,
        marketplace_status: record.marketplace_status,
        reason: `The ${record.code.toUpperCase()} marketplace is "${record.marketplace_status}" — it has no public catalog.`,
      },
    }
  }

  const channel = resolveMarketplaceChannelForMarket(requested, env)
  if (channel.status !== 'resolved') {
    return {
      ok: false,
      kind: 'unavailable',
      status: 503,
      body: {
        unavailable: true,
        market_code: record.code,
        marketplace_status: record.marketplace_status,
        reason: channel.reason,
      },
    }
  }

  return { ok: true, market: record.code, channel_id: channel.id }
}

/** A product row carrying (at least) its Sales Channel link ids. */
export interface ChannelScopedProduct {
  readonly sales_channels?: ReadonlyArray<{ id?: string } | null | undefined> | null
}

/**
 * Is this product a member of the market's marketplace Sales Channel?
 *
 * The `sc && sc.id` guard is not defensive noise: `query.graph` expands a DANGLING
 * link row (a link to a since-deleted channel) into a null-ish entry with no `id`,
 * and 15 such rows existed in production in July 2026 after channels were pruned
 * without the delete workflow. An unguarded dereference there took down
 * `/internal/backfill-sales-channel` twice. A null-ish row is "not this channel",
 * which is the fail-closed reading.
 */
export function productInMarketplaceChannel(product: ChannelScopedProduct, channelId: string): boolean {
  return (product.sales_channels ?? []).some((sc) => !!sc && sc.id === channelId)
}

/** Keep only the products published into the market's marketplace channel. */
export function filterToMarketplaceChannel<T extends ChannelScopedProduct>(
  products: readonly T[],
  channelId: string,
): T[] {
  return products.filter((product) => productInMarketplaceChannel(product, channelId))
}

/**
 * The membership state of a product population against a market's channel.
 *
 * This lives HERE, next to `productInMarketplaceChannel`, on purpose: the dry-run
 * report that decides whether switching the filter on is a no-op must count
 * membership with the EXACT predicate the filter uses. Two definitions of "in the
 * channel" would let the report promise zero hidden products while the boundary
 * hides some.
 */
export interface MarketplaceMembershipReport<T> {
  readonly scanned: number
  readonly linked: number
  /** Products that would be HIDDEN the moment the read boundary ships. */
  readonly missing: T[]
  /**
   * Link rows that came back null-ish (a link to a deleted channel). Counted
   * separately because "this product has no channel link" and "this product has a
   * link we could not read" are different facts, and the second one means the
   * report is under-reporting.
   */
  readonly unusable_link_rows: number
}

export function reportMarketplaceMembership<T extends ChannelScopedProduct>(
  products: readonly T[],
  channelId: string,
): MarketplaceMembershipReport<T> {
  let unusable = 0
  const missing: T[] = []
  for (const product of products) {
    for (const sc of product.sales_channels ?? []) {
      if (!sc || !sc.id) unusable += 1
    }
    if (!productInMarketplaceChannel(product, channelId)) missing.push(product)
  }
  return {
    scanned: products.length,
    linked: products.length - missing.length,
    missing,
    unusable_link_rows: unusable,
  }
}

/**
 * The extra graph fields a marketplace read must request to be able to filter.
 *
 * Exported as a constant so the two routes cannot drift into asking for different
 * shapes — the filter is only as correct as the field that feeds it, and a route
 * that forgets it would see every product as channel-less and return an empty
 * catalog.
 */
export const MARKETPLACE_CHANNEL_FIELDS = ['sales_channels.id'] as const
