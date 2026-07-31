/**
 * market-protected-resources.ts — the registry allow-list that stands between the
 * two destructive setup paths and a multi-market future (epic README, D6).
 *
 * Both scripts were written when exactly one market existed and both express that
 * assumption as a DELETE:
 *   · `POST /internal/setup-mexico` step 6 — deletes every Region that is not the
 *     Mexico one (it was written to remove Medusa's seeded EUR starter Region).
 *   · `src/scripts/cleanup-default-data.ts` step 3 — `delete from sales_channel
 *     where id <> KEEP`.
 * Neither has ever run against production for the channel path (session journal,
 * 2026-07-28), so these are LATENT LANDMINE fixes, not live behaviour changes. Say
 * that in the PR rather than claiming a live effect.
 *
 * The functions here are pure and take the population as an argument precisely so the
 * dry-run report and the destructive call cannot disagree about what would be deleted.
 */

import { MARKET_CODES, MARKETS } from '../../../lib/markets'
import {
  type MarketMedusaEnv,
  registryRegionIds,
  resolveMarketplaceChannelForMarket,
  resolveOperatingChannelForMarket,
} from '../../../lib/market-medusa'

export interface RegionLike {
  readonly id: string
  readonly name?: string | null
  readonly currency_code?: string | null
}

export type RegionKeepReason =
  /** The Mexico Region this setup route maintains. */
  | 'mexico_region'
  /** A Region a registry market resolves to via its env var. */
  | 'registry_region_id'
  /** A Region whose currency belongs to a registry market — see below. */
  | 'registry_currency'
  /** At least one real product price is denominated in this Region's currency. */
  | 'price_in_use'

export interface RegionDeletionPlan {
  readonly keep: Array<{ id: string; name: string | null; currency_code: string | null; reason: RegionKeepReason }>
  readonly remove: Array<{ id: string; name: string | null; currency_code: string | null }>
}

/**
 * Decide which Regions step 6 may delete.
 *
 * Three protections, in order of strength:
 *
 * 1. `mexico_region` — the Region this route itself creates/maintains (matched by id
 *    OR by the literal name "Mexico", exactly as the original code did).
 * 2. `registry_region_id` — any Region a market resolves to through
 *    `resolveRegionIdForMarket`. This is D6 as written.
 * 3. `registry_currency` — any Region whose currency is a registry market's currency.
 *    This one is ADDITIVE to D6 and it matters here specifically: the backend has no
 *    `MEDUSA_MXN_REGION_ID` in its environment today (that var lives in the frontend),
 *    so protection (2) resolves to an EMPTY set in this repo right now. A US Region
 *    created by hand before anyone sets a `MEDUSA_US_REGION_ID` would therefore be
 *    protected by NOTHING. A guard whose allow-list is empty in production is not a
 *    guard. `eur` is not a registry currency, so the seeded Europe Region this step
 *    exists to remove is still removable — the documented behaviour is unchanged.
 * 4. `price_in_use` — the pre-existing safety re-check: never delete a Region whose
 *    currency carries a real product price. Kept verbatim in spirit; it is the check
 *    that makes a re-run on a different database safe.
 */
export function planRegionDeletions(
  regions: readonly RegionLike[],
  opts: {
    readonly mexicoRegionId?: string | null
    readonly env: MarketMedusaEnv
    readonly currenciesInUse: ReadonlySet<string>
  },
): RegionDeletionPlan {
  const protectedIds = new Set(registryRegionIds(opts.env))
  const registryCurrencies = new Set(MARKET_CODES.map((code) => MARKETS[code].currency_code))

  const keep: RegionDeletionPlan['keep'] = []
  const remove: RegionDeletionPlan['remove'] = []

  for (const region of regions) {
    const row = {
      id: region.id,
      name: region.name ?? null,
      currency_code: region.currency_code ?? null,
    }
    const currency = (region.currency_code ?? '').toLowerCase()

    if ((opts.mexicoRegionId && region.id === opts.mexicoRegionId) || region.name === 'Mexico') {
      keep.push({ ...row, reason: 'mexico_region' })
    } else if (protectedIds.has(region.id)) {
      keep.push({ ...row, reason: 'registry_region_id' })
    } else if (currency && registryCurrencies.has(currency)) {
      keep.push({ ...row, reason: 'registry_currency' })
    } else if (currency && opts.currenciesInUse.has(currency)) {
      keep.push({ ...row, reason: 'price_in_use' })
    } else {
      remove.push(row)
    }
  }

  return { keep, remove }
}

/**
 * Render a keep decision as the operator-facing report line the setup route emits.
 * Separated so the wording lives with the rule that produced it.
 */
export function describeRegionKeep(entry: RegionDeletionPlan['keep'][number]): string {
  switch (entry.reason) {
    case 'mexico_region':
      return `○ Region "${entry.name}" (${entry.id}) — the Mexico region — kept`
    case 'registry_region_id':
      return `○ Region "${entry.name}" (${entry.id}, ${entry.currency_code}) — a registry market resolves to it — NOT deleted`
    case 'registry_currency':
      return `○ Region "${entry.name}" (${entry.id}, ${entry.currency_code}) — its currency belongs to a registry market — NOT deleted`
    case 'price_in_use':
      return `⚠ Region "${entry.name}" (${entry.id}, ${entry.currency_code}) — at least one real product price uses this currency — NOT deleted, needs manual review`
  }
}

export type ProtectedChannelPlan =
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly blocked_by: readonly string[] }

/**
 * A destructive channel sweep may start only when every active marketplace channel,
 * every active OPERATING channel (owned-shop-operating-channel epic, D10), and the
 * store default are positively known. "Unconfigured" is unavailable, not an empty
 * allow-list.
 *
 * The operating channel is guarded here with the SAME strictness as the marketplace
 * channel — `unconfigured` blocks the whole sweep rather than silently protecting
 * fewer channels — which is a deliberately more conservative rule than the sibling
 * `protectedSalesChannelIds` (`lib/market-medusa.ts`) applies for `cleanup-
 * default-data.ts`: that script's allow-list quietly omits an unconfigured channel
 * (there is nothing yet to protect against, since the channel row does not exist
 * before it is created), whereas THIS route deletes channels outright, so an operator
 * who has not yet finished provisioning must see "unavailable", never a prune that
 * ran short-listed. `no_resource` (a market this epic never touches, `us`) is not a
 * block — only `unconfigured` is.
 */
export function planProtectedSalesChannels(
  env: MarketMedusaEnv,
  storeDefaultChannelId: unknown,
): ProtectedChannelPlan {
  const ids = new Set<string>()
  const blocked: string[] = []
  const storeDefault = typeof storeDefaultChannelId === 'string' ? storeDefaultChannelId.trim() : ''
  if (!storeDefault) blocked.push('The store default Sales Channel could not be resolved.')
  else ids.add(storeDefault)

  for (const code of MARKET_CODES) {
    if (MARKETS[code].marketplace_status !== 'active') continue

    const channel = resolveMarketplaceChannelForMarket(code, env)
    if (channel.status === 'resolved') ids.add(channel.id)
    else blocked.push(channel.reason)

    const operating = resolveOperatingChannelForMarket(code, env)
    if (operating.status === 'resolved') ids.add(operating.id)
    else if (operating.status === 'unconfigured') blocked.push(operating.reason)
    // `no_resource` ⇒ structurally absent for this market — nothing to add, nothing
    // to block on.
  }
  return blocked.length > 0
    ? { ok: false, blocked_by: blocked }
    : { ok: true, ids: [...ids] }
}
