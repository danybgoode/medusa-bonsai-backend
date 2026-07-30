/**
 * market-medusa.ts — the seam between the pure market registry and THIS repo's
 * Medusa environment.
 *
 * `markets.ts` deliberately holds no Medusa Region id and no Sales Channel id: those
 * differ per environment (local / staging / production), so an id in the registry
 * would be a lie everywhere but one place (epic README, D2). This file is where a
 * market code becomes a concrete Medusa id, and it does it by reading an INJECTED
 * env object — never `process.env` directly — so every branch is unit-testable with
 * no ambient environment and no container.
 *
 * THREE STATES, NEVER TWO. `resolveMarketplaceChannelId('us')` and
 * `resolveMarketplaceChannelId('mx')` in an environment that forgot to set
 * `MEDUSA_SALES_CHANNEL_ID` both produce "no id", but they are completely different
 * facts:
 *   · `us`  — known-absent. There is no US Sales Channel and no US Region in ANY
 *             environment (D0: production holds exactly 1 Region and 2 Sales
 *             Channels, all Mexico). US is fail-closed by construction.
 *   · `mx` with the env var missing — UNCONFIGURED. An operator mistake. The
 *             marketplace exists; we simply cannot address it.
 * Collapsing those into one `null` is how a misconfigured deploy would read as
 * "this market has no marketplace" and quietly serve nothing while looking healthy.
 * The `*Resolution` functions keep them apart; the `*Id` helpers below are the
 * convenience shape the build contract asks for and are defined in terms of them.
 */

import {
  MARKET_CODES,
  type MarketCode,
  requireMarket,
} from './markets'

/**
 * The env shape this seam reads. Injected, never `process.env` — a route passes
 * `process.env`, a spec passes an object literal.
 */
export interface MarketMedusaEnv {
  readonly MEDUSA_MXN_REGION_ID?: string
  readonly MEDUSA_SALES_CHANNEL_ID?: string
}

/**
 * Which env var (if any) carries each market's Medusa ids.
 *
 * A market with no entry has no such resource IN ANY ENVIRONMENT — that is a
 * structural fact about the platform today, not a configuration gap. Standing up a
 * US Region later is one row here plus one env var, and until both exist every
 * caller reads a `no_resource` resolution rather than a Mexico id.
 */
const MARKET_MEDUSA_ENV_KEYS: Readonly<Record<MarketCode, {
  readonly region?: keyof MarketMedusaEnv
  readonly marketplace_channel?: keyof MarketMedusaEnv
}>> = Object.freeze({
  mx: Object.freeze({
    region: 'MEDUSA_MXN_REGION_ID',
    marketplace_channel: 'MEDUSA_SALES_CHANNEL_ID',
  }),
  // D0, re-derived against production 2026-07-28: exactly one Region (Mexico/MXN)
  // and two Sales Channels (the default one and the Mexico marketplace one). There
  // is nothing for `us` to point at, so it resolves to `no_resource` — never to the
  // Mexico ids.
  us: Object.freeze({}),
})

export type MedusaResourceKind = 'region' | 'marketplace_channel'

/**
 * The outcome of turning a market code into a Medusa id.
 *
 *   resolved     — an id exists and is configured.
 *   no_resource  — this market has no such Medusa resource anywhere. Structural.
 *   unconfigured — the resource is expected for this market but the env var that
 *                  names it is missing/empty. Operator error; callers must fail
 *                  closed and SAY SO rather than falling back to another market.
 */
export type MedusaIdResolution =
  | { readonly status: 'resolved'; readonly market: MarketCode; readonly kind: MedusaResourceKind; readonly id: string }
  | { readonly status: 'no_resource'; readonly market: MarketCode; readonly kind: MedusaResourceKind; readonly reason: string }
  | { readonly status: 'unconfigured'; readonly market: MarketCode; readonly kind: MedusaResourceKind; readonly env_var: string; readonly reason: string }

function resolve(
  value: unknown,
  kind: MedusaResourceKind,
  env: MarketMedusaEnv,
): MedusaIdResolution {
  // `requireMarket` throws `UnknownMarketError` — including the loud "that looks
  // like a LOCALE" hint (D3). An unknown market must never reach an id lookup.
  const market = requireMarket(value).code
  const envKey = MARKET_MEDUSA_ENV_KEYS[market][kind]

  if (!envKey) {
    return {
      status: 'no_resource',
      market,
      kind,
      reason: `Market "${market}" has no Medusa ${kind} in any environment.`,
    }
  }

  const raw = env[envKey]
  const id = typeof raw === 'string' ? raw.trim() : ''
  if (!id) {
    return {
      status: 'unconfigured',
      market,
      kind,
      env_var: envKey,
      reason: `Market "${market}" expects a Medusa ${kind} but ${envKey} is unset. ` +
        'Refusing to guess — fail closed rather than serving another market\'s resource.',
    }
  }

  return { status: 'resolved', market, kind, id }
}

/** Full resolution (three states) for a market's Medusa Region. */
export function resolveRegionForMarket(value: unknown, env: MarketMedusaEnv): MedusaIdResolution {
  return resolve(value, 'region', env)
}

/** Full resolution (three states) for a market's marketplace Sales Channel. */
export function resolveMarketplaceChannelForMarket(value: unknown, env: MarketMedusaEnv): MedusaIdResolution {
  return resolve(value, 'marketplace_channel', env)
}

/**
 * The Medusa Region id for a market, or `null`.
 *
 * `mx` → `MEDUSA_MXN_REGION_ID`; `us` → `null` (no US Region — D0); unknown ⇒ throws
 * `UnknownMarketError`. Use `resolveRegionForMarket` when the caller must
 * distinguish "no US Region exists" from "someone forgot the env var" — this shape
 * deliberately collapses them and is only safe where both mean "cannot proceed".
 *
 * NOTE for this repo specifically: `MEDUSA_MXN_REGION_ID` is a FRONTEND env var
 * today (`apps/miyagisanchez/lib/medusa.ts`); the backend resolves its Region from
 * the database, so this function usually answers `unconfigured` here. That is
 * correct and harmless — no backend caller uses the id for commerce. It exists so
 * the destructive setup guard (D6) can protect a registry-addressable Region when
 * the var IS present, and so the two repos' seams stay shaped alike.
 */
export function resolveRegionIdForMarket(value: unknown, env: MarketMedusaEnv): string | null {
  const resolution = resolveRegionForMarket(value, env)
  return resolution.status === 'resolved' ? resolution.id : null
}

/**
 * The marketplace Sales Channel id for a market, or `null`.
 *
 * `mx` → `MEDUSA_SALES_CHANNEL_ID` (production: `sc_01KSK1J0V81P4EPY9G0JAPX353`,
 * the channel the storefront's only publishable key is linked to — D0);
 * `us` → `null`; unknown ⇒ throws `UnknownMarketError`.
 */
export function resolveMarketplaceChannelId(value: unknown, env: MarketMedusaEnv): string | null {
  const resolution = resolveMarketplaceChannelForMarket(value, env)
  return resolution.status === 'resolved' ? resolution.id : null
}

/**
 * Every Medusa Region id that ANY registry market resolves to in this environment.
 *
 * Used by the destructive-setup guard (D6): `setup-mexico` step 6 must never delete
 * a Region a market can address. Derived from `MARKET_CODES` so a new market is
 * protected the moment it is added — never maintain a second list.
 */
export function registryRegionIds(env: MarketMedusaEnv): string[] {
  return dedupe(MARKET_CODES.map((code) => resolveRegionIdForMarket(code, env)))
}

/**
 * Every marketplace Sales Channel id that ANY registry market resolves to.
 *
 * Used by `cleanup-default-data.ts` and `/internal/prune-sales-channels`: both
 * delete "every channel that is not the one we keep", which is only safe while
 * exactly one market exists. Guard the population, not the door you found.
 */
export function registryMarketplaceChannelIds(env: MarketMedusaEnv): string[] {
  return dedupe(MARKET_CODES.map((code) => resolveMarketplaceChannelId(code, env)))
}

/**
 * The full set of Sales Channel ids a destructive cleanup must never delete:
 * every registry-declared marketplace channel PLUS the store's own default channel.
 *
 * `store.default_sales_channel_id` is included because Medusa refuses to delete a
 * channel that is still a store default (it would orphan the store), and because in
 * production it is a DIFFERENT channel from the marketplace one — a known, harmless,
 * out-of-scope divergence recorded in D0. Both must survive.
 */
export function protectedSalesChannelIds(
  env: MarketMedusaEnv,
  storeDefaultChannelId?: string | null,
): string[] {
  return dedupe([...registryMarketplaceChannelIds(env), storeDefaultChannelId ?? null])
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()))]
}
