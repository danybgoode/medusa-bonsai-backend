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
  resolvePublishableKeyForMarket,
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
 * fewer channels. Both destructive callers now use this same complete-population
 * refusal: an operator who has not finished provisioning sees "unavailable", never
 * a prune that ran with a shortened allow-list. A future structurally absent
 * resource (`no_resource`) remains the only safe omission.
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
    // Protect expected resources before a market is activated. Invitation status
    // controls publication, not whether a destructive sweep may forget its rows.
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

/**
 * Every active market whose OPERATING channel is `unconfigured`, as human-readable
 * reasons — empty when there is nothing to refuse on.
 *
 * WHY THIS IS SEPARATE FROM `planProtectedSalesChannels`: that function guards
 * `POST /internal/prune-sales-channels`, which resolves its own store default and
 * blocks on an unconfigured MARKETPLACE channel too. `cleanup-default-data.ts` has a
 * different shape — it carries a hardcoded `KEEP_CHANNEL_ID` backstop for the
 * marketplace channel and ABORTs when that row will not resolve, so the marketplace
 * half is already covered there and re-blocking on it would be a behaviour change
 * beyond this epic. What that script has NO backstop for is the operating channel,
 * and it deliberately gets none: the whole point of a registry-derived allow-list is
 * that ids are not hand-maintained.
 *
 * That leaves exactly one lethal gap, which this closes (owned-shop-operating-channel
 * epic, D10). Once the operating channel EXISTS in the database but
 * `MEDUSA_MX_OPERATING_CHANNEL_ID` is unset in the environment running the script,
 * `protectedSalesChannelIds` omits it *silently* and the delete takes the channel AND
 * every `product_sales_channel` row pointing at it. Not theoretical: the script runs
 * via `medusa exec`, where env comes from a local `.env` rather than the Cloud Run
 * service — so the machine most likely to run it is the least likely to carry the new
 * var.
 *
 * "I could not check" and "there is nothing to protect" are different facts; only the
 * second one is safe to delete against. A future `no_resource` registry entry is the
 * genuinely-absent case and never blocks.
 */
export function unconfiguredOperatingChannelReasons(env: MarketMedusaEnv): string[] {
  const reasons: string[] = []
  for (const code of MARKET_CODES) {
    const operating = resolveOperatingChannelForMarket(code, env)
    if (operating.status === 'unconfigured') reasons.push(operating.reason)
  }
  return reasons
}

/**
 * A credential sweep may run only when every market-owned publishable key is
 * positively configured. This intentionally blocks during the provisioning window:
 * a just-created US key is most vulnerable before its token reaches Cloud Run.
 */
export function planProtectedPublishableKeys(env: MarketMedusaEnv):
  | { readonly ok: true; readonly tokens: readonly string[] }
  | { readonly ok: false; readonly blocked_by: readonly string[] } {
  const tokens: string[] = []
  const blocked: string[] = []
  for (const code of MARKET_CODES) {
    const key = resolvePublishableKeyForMarket(code, env)
    if (key.status === 'resolved') {
      if (tokens.includes(key.token)) {
        blocked.push(`Publishable key token for ${code} duplicates another market token; refusing an ambiguous credential allow-list.`)
      } else tokens.push(key.token)
    }
    else blocked.push(key.reason)
  }
  return blocked.length > 0
    ? { ok: false, blocked_by: blocked }
    : { ok: true, tokens }
}
