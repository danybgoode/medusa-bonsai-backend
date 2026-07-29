/**
 * seller-market.ts — THE single reader and writer of `seller.metadata.operating_market`.
 *
 * A shop's operating market is a different fact from its marketplace publication: a
 * merchant may operate an owned shop in a market without ever being admitted to that
 * country's marketplace (epic README, product contract). Marketplace membership is
 * Sales Channel truth; the operating market lives here.
 *
 * WHY A HELPER AND NOT `seller.metadata.operating_market` AT THE CALL SITE: that
 * metadata column is untyped JSON shared by every shop setting (stripe connect,
 * shipping, theme…). Every ad-hoc read of a JSON blob invents its own normalisation
 * and its own answer for "absent" — which is exactly how a market boundary drifts
 * permissive. One reader, one writer, one place to change.
 *
 * NO DATABASE MIGRATION (D12): this rides the existing `metadata` json column on the
 * Medusa `seller` model. There is no DDL in this epic.
 */

import {
  DEFAULT_MARKET,
  type MarketCode,
  type MarketRecord,
  MARKETS,
  isMarketCode,
  normalizeMarketCode,
  requireMarket,
  isMarketplaceOpen,
  UnknownMarketError,
} from './markets'
import {
  type MarketMedusaEnv,
  resolveRegionIdForMarket,
  resolveMarketplaceChannelId,
} from './market-medusa'

/** The metadata key. Stated once so no caller spells it a second way. */
export const SELLER_OPERATING_MARKET_KEY = 'operating_market'

/**
 * The result of reading a seller's operating market.
 *
 * THREE STATES, NEVER TWO — "stored", "never set" and "set to something we do not
 * recognise" are different facts and the backfill must treat them differently:
 *
 *   metadata       — a supported market code was stored. Authoritative.
 *   legacy_default — the key is absent. Resolves to `DEFAULT_MARKET` (`mx`).
 *   invalid        — a value is stored that is not a supported market (a locale, a
 *                    country name, a typo, a market we have since retired). The
 *                    market is `null`: callers must fail closed or abort, NEVER
 *                    silently substitute Mexico. Guessing here would attach a shop
 *                    to the wrong country's commerce rails.
 */
export type SellerOperatingMarketRead =
  | { readonly market: MarketCode; readonly source: 'metadata'; readonly raw: string }
  | { readonly market: MarketCode; readonly source: 'legacy_default'; readonly raw: null }
  | { readonly market: null; readonly source: 'invalid'; readonly raw: unknown }

/** Anything with the Medusa seller's untyped metadata bag. */
export interface SellerMetadataCarrier {
  readonly metadata?: unknown
}

function metadataBag(source: unknown): Record<string, unknown> | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  return source as Record<string, unknown>
}

/**
 * Read the operating market off a seller's metadata bag (or off the seller itself —
 * both shapes are accepted because half the call sites hold one and half the other).
 *
 * ABSENT ⇒ `DEFAULT_MARKET` and it says so via `source: 'legacy_default'`.
 *
 * That default exists ONLY for the pre-launch migration window: every seller in the
 * database predates this registry and was created in a single-market Mexico system,
 * so "unspecified" genuinely means `mx` for that exact population (D0: 0 sellers
 * carry the key today; 18 sellers have published products). It is a
 * backward-compatibility default over a KNOWN population, not a fallback for unknown
 * input — an unrecognised stored value returns `invalid`, and every WRITE requires an
 * explicit supported market. Once the backfill has run, `legacy_default` should
 * describe nobody, and a caller seeing it can treat it as a data-repair signal.
 */
export function readSellerOperatingMarket(source: unknown): SellerOperatingMarketRead {
  const carrier = metadataBag(source)
  // Accept either the seller row or its metadata bag directly.
  const bag = carrier && SELLER_OPERATING_MARKET_KEY in carrier
    ? carrier
    : metadataBag((carrier as SellerMetadataCarrier | null)?.metadata) ?? carrier

  const raw = bag ? bag[SELLER_OPERATING_MARKET_KEY] : undefined

  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { market: DEFAULT_MARKET, source: 'legacy_default', raw: null }
  }
  if (!isMarketCode(raw)) {
    return { market: null, source: 'invalid', raw }
  }
  return { market: normalizeMarketCode(raw)!, source: 'metadata', raw: (raw as string).trim().toLowerCase() }
}

/**
 * The seller's operating market, or THROW on a stored value we do not recognise.
 *
 * Use at any seam that must not proceed on an ambiguous shop: resolving commerce
 * rails, publishing to a marketplace, quoting shipping. The exception IS the
 * fail-closed behaviour.
 */
export function requireSellerOperatingMarket(source: unknown): MarketCode {
  const read = readSellerOperatingMarket(source)
  if (read.market) return read.market
  throw new UnknownMarketError(
    read.raw,
    `Seller metadata.${SELLER_OPERATING_MARKET_KEY} holds an unsupported value. ` +
    'Repair the row (see GET /internal/market-backfill) — it will not be defaulted.',
  )
}

/**
 * Produce the metadata bag to persist for a seller in `market`.
 *
 * WRITES REQUIRE AN EXPLICIT SUPPORTED MARKET — `requireMarket` throws on anything
 * else, including a locale (D3). There is deliberately no "write the default"
 * overload: a shop-creation seam that does not know its market must decide, not
 * inherit. In particular the market is NEVER inferred from a browser locale
 * (Accept-Language is presentation; the registry keeps locale as a FIELD of a market
 * precisely so the two cannot be confused).
 *
 * Returns a NEW object — the caller passes it to `updateSellers`; this function
 * performs no I/O so it stays unit-testable.
 */
export function setSellerOperatingMarket(
  currentMetadata: unknown,
  market: unknown,
): Record<string, unknown> {
  const record = requireMarket(market)
  const bag = metadataBag(currentMetadata) ?? {}
  return { ...bag, [SELLER_OPERATING_MARKET_KEY]: record.code }
}

/**
 * The commerce rails a seller's market is entitled to.
 *
 * This is the answer to "an unsupported market must not silently inherit Mexico
 * Stripe/shipping settings": every rail below is derived from the seller's OWN
 * market, so a non-Mexico shop gets `region_id: null`, `marketplace_channel_id: null`
 * and its own currency — there is no code path that hands it the MXN Region, the MX
 * marketplace channel, or a Mexico-only carrier. A caller that finds `region_id`
 * null must refuse the operation, not substitute one.
 */
export interface SellerMarketContext {
  readonly market: MarketCode
  readonly source: SellerOperatingMarketRead['source']
  readonly record: MarketRecord
  /** Presentation only. Never read this to pick currency, payment or shipping. */
  readonly default_locale: string
  readonly currency_code: string
  /** Medusa Region for this seller's checkout, or null when the market has none. */
  readonly region_id: string | null
  /** Marketplace Sales Channel, or null when the market's marketplace is not open. */
  readonly marketplace_channel_id: string | null
  /** `marketplace_status === 'active'`. `us` is `invitation` ⇒ false. */
  readonly marketplace_open: boolean
}

/**
 * Resolve everything a seller's market implies, in one place.
 *
 * Throws `UnknownMarketError` when the stored value is unrecognised — see
 * `requireSellerOperatingMarket`.
 */
export function resolveSellerMarketContext(
  source: unknown,
  env: MarketMedusaEnv,
): SellerMarketContext {
  const read = readSellerOperatingMarket(source)
  const market = requireSellerOperatingMarket(source)
  const record = MARKETS[market]
  const open = isMarketplaceOpen(market)
  return {
    market,
    source: read.source,
    record,
    default_locale: record.default_locale,
    currency_code: record.currency_code,
    region_id: resolveRegionIdForMarket(market, env),
    // A market whose marketplace is not open has no marketplace channel to be in,
    // even if someone later sets an env var for it. Status first, id second.
    marketplace_channel_id: open ? resolveMarketplaceChannelId(market, env) : null,
    marketplace_open: open,
  }
}

/**
 * The public projection of a seller's market for shop/UCP reads.
 *
 * Story 1.2 asks that these surfaces expose the market code WITHOUT exposing
 * seller metadata: `seller.metadata` also carries Stripe Connect account ids,
 * payout config and private shop settings, so a route must never spread the whole
 * bag to satisfy "show the market". This returns exactly the three public facts.
 */
export function publicSellerMarket(source: unknown): {
  market_code: MarketCode | null
  country_code: string | null
  marketplace_status: MarketRecord['marketplace_status'] | null
} {
  const read = readSellerOperatingMarket(source)
  if (!read.market) {
    // Unknown stored value: report absence honestly rather than defaulting to mx on
    // a PUBLIC surface, where a wrong country is a wrong claim to every agent
    // reading it.
    return { market_code: null, country_code: null, marketplace_status: null }
  }
  const record = MARKETS[read.market]
  return {
    market_code: record.code,
    country_code: record.country_code,
    marketplace_status: record.marketplace_status,
  }
}

/**
 * Plan the pre-launch MX backfill over a seller population — PURE, so the dry-run
 * report and the apply path cannot disagree about what would change.
 *
 * `unknown` is not "skip": the caller ABORTS on a non-empty `unknown` list rather
 * than backfilling around it (build contract item 6). A row we cannot classify is a
 * row we must not touch, and it is also the signal that something else wrote to this
 * key.
 */
export interface SellerBackfillCandidate {
  readonly id: string
  readonly slug?: string | null
  readonly metadata?: unknown
}

export interface SellerMarketBackfillPlan {
  readonly target: MarketCode
  readonly updates: Array<{ id: string; slug: string | null; current: null; proposed: MarketCode }>
  readonly unchanged: Array<{ id: string; slug: string | null; current: MarketCode }>
  readonly unknown: Array<{ id: string; slug: string | null; raw: unknown }>
  /** True when nothing may be applied — an unclassifiable row is present. */
  readonly abort: boolean
}

export function planSellerMarketBackfill(
  sellers: readonly SellerBackfillCandidate[],
  target: MarketCode = DEFAULT_MARKET,
): SellerMarketBackfillPlan {
  const market = requireMarket(target).code
  const updates: SellerMarketBackfillPlan['updates'] = []
  const unchanged: SellerMarketBackfillPlan['unchanged'] = []
  const unknown: SellerMarketBackfillPlan['unknown'] = []

  for (const seller of sellers) {
    const slug = seller.slug ?? null
    const read = readSellerOperatingMarket(seller)
    if (read.source === 'invalid') {
      unknown.push({ id: seller.id, slug, raw: read.raw })
      continue
    }
    if (read.source === 'legacy_default') {
      updates.push({ id: seller.id, slug, current: null, proposed: market })
      continue
    }
    // Already carries a value. A seller explicitly in ANOTHER market is left alone —
    // this backfill states "unspecified means mx", never "everyone is mx".
    unchanged.push({ id: seller.id, slug, current: read.market })
  }

  return { target: market, updates, unchanged, unknown, abort: unknown.length > 0 }
}
