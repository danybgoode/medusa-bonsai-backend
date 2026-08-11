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
 * so "unspecified" genuinely means `mx` for that measured pre-launch population.
 * It is a backward-compatibility default over a KNOWN population, not a fallback for unknown
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
  // LENIENT ON READ, STRICT ON WRITE — deliberately, and this is the one place the
  // asymmetry matters. `isMarketCode` is a strict type predicate (canonical form
  // only, for soundness); using it here would classify a stored `'MX'` as `invalid`,
  // and `invalid` is not a soft failure — `planSellerMarketBackfill` ABORTS THE WHOLE
  // RUN on a single unclassifiable row. One stray capital letter, typed by hand in
  // Admin or written by some future tool, would then block the backfill for every
  // seller. `normalizeMarketCode` canonicalises instead, and `raw` below carries the
  // CANONICAL value, so nothing downstream ever holds a non-canonical string typed as
  // a MarketCode. Writes stay strict: `setSellerOperatingMarket` only ever persists
  // `requireMarket(...).code`, so the untidy input can only arrive from outside this
  // module in the first place.
  const normalized = normalizeMarketCode(raw)
  if (!normalized) {
    return { market: null, source: 'invalid', raw }
  }
  return { market: normalized, source: 'metadata', raw: normalized }
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

export type SellerCreationMarketPlan =
  | { readonly status: 'create'; readonly market: MarketCode }
  | { readonly status: 'idempotent'; readonly market: MarketCode }
  | { readonly status: 'conflict'; readonly existing_market: MarketCode; readonly requested_market: MarketCode }
  | { readonly status: 'invalid'; readonly message: string }

/**
 * Decide the market outcome of a retryable seller-create request. The omission
 * default is MX only for a genuinely fresh row. Once a shop exists its stored
 * market is immutable: a same-market retry is idempotent and a conflicting retry
 * is a 409, never a silent re-marketization.
 */
export function planSellerCreationMarket(
  existingSeller: unknown | null,
  requestedMarket: unknown,
): SellerCreationMarketPlan {
  const omitted = requestedMarket === undefined || requestedMarket === null
    || (typeof requestedMarket === 'string' && requestedMarket.trim() === '')
  if (existingSeller && omitted) {
    const existing = readSellerOperatingMarket(existingSeller)
    return existing.market
      ? { status: 'idempotent', market: existing.market }
      : {
        status: 'invalid',
        message: `Existing seller has invalid metadata.${SELLER_OPERATING_MARKET_KEY}; repair it before retrying creation.`,
      }
  }
  let requested: MarketCode
  try {
    requested = requireMarket(requestedMarket ?? DEFAULT_MARKET).code
  } catch (e) {
    return { status: 'invalid', message: (e as Error).message }
  }
  if (!existingSeller) return { status: 'create', market: requested }

  const existing = readSellerOperatingMarket(existingSeller)
  if (!existing.market) {
    return {
      status: 'invalid',
      message: `Existing seller has invalid metadata.${SELLER_OPERATING_MARKET_KEY}; repair it before retrying creation.`,
    }
  }
  if (existing.market === requested) return { status: 'idempotent', market: existing.market }
  return {
    status: 'conflict',
    existing_market: existing.market,
    requested_market: requested,
  }
}

/**
 * The commerce rails a seller's market is entitled to.
 *
 * This is the answer to "an unsupported market must not silently inherit Mexico
 * Stripe/shipping settings": every rail below is derived from the seller's OWN
 * market, so a US shop gets its configured US Region, an invitation-stage
 * `marketplace_channel_id: null`, and USD — there is no code path that hands it the
 * MXN Region, the MX marketplace channel, or a Mexico-only carrier. A caller that
 * finds an expected `region_id` null must refuse the operation, not substitute one.
 */
export interface SellerMarketContext {
  readonly market: MarketCode
  readonly source: SellerOperatingMarketRead['source']
  readonly record: MarketRecord
  /** Presentation only. Never read this to pick currency, payment or shipping. */
  readonly default_locale: string
  readonly currency_code: string
  /** Medusa Region for this seller's checkout, or null when its expected env is unavailable. */
  readonly region_id: string | null
  /** Marketplace Sales Channel, or null when the market's marketplace is not open. */
  readonly marketplace_channel_id: string | null
  /** `marketplace_status === 'active'`. */
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
 * bag to satisfy "show the market". This returns only registry-backed public facts.
 */
export function publicSellerMarket(source: unknown): {
  market_code: MarketCode | null
  country_code: string | null
  currency_code: string | null
  marketplace_status: MarketRecord['marketplace_status'] | null
} {
  const read = readSellerOperatingMarket(source)
  if (!read.market) {
    // Unknown stored value: report absence honestly rather than defaulting to mx on
    // a PUBLIC surface, where a wrong country is a wrong claim to every agent
    // reading it.
    return { market_code: null, country_code: null, currency_code: null, marketplace_status: null }
  }
  const record = MARKETS[read.market]
  return {
    market_code: record.code,
    country_code: record.country_code,
    currency_code: record.currency_code,
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

/**
 * Plan which products may be linked into a market's marketplace channel — PURE.
 *
 * The rule a cross-review had to add: **a product is only ever linked into the market
 * its OWNING SELLER operates in.** The first draft linked every published product with
 * no MX link, which would have silently published a non-Mexico shop's catalog into the
 * Mexico marketplace — and, once "owned shop only" existed, would have destroyed an
 * explicit opt-out on the very next backfill run.
 *
 * A product whose owner cannot be resolved is NOT linked. That is the fail-closed
 * reading: we cannot prove it belongs in this market, and an orphaned product is a
 * data-repair job (there is a whole sweep for it), not something a backfill should
 * quietly adopt into a country marketplace. It is reported, not skipped in silence.
 */
export interface MarketLinkCandidate {
  readonly id: string
  /** The owning seller's market, or `null` when no owner could be resolved. */
  readonly owner_market: MarketCode | null
  readonly owner_seller_id?: string | null
}

export interface MarketplaceLinkPlan {
  readonly target: MarketCode
  /** Product ids safe to link into `target`'s marketplace channel. */
  readonly link: string[]
  /** Owned by a seller operating in a DIFFERENT market — never linked. */
  readonly skipped_other_market: Array<{ id: string; owner_market: MarketCode }>
  /** No resolvable owner — never linked, always reported. */
  readonly skipped_unowned: string[]
}

export function planMarketplaceLinkBackfill(
  candidates: readonly MarketLinkCandidate[],
  target: MarketCode = DEFAULT_MARKET,
): MarketplaceLinkPlan {
  const market = requireMarket(target).code
  const link: string[] = []
  const skipped_other_market: MarketplaceLinkPlan['skipped_other_market'] = []
  const skipped_unowned: string[] = []

  for (const candidate of candidates) {
    if (candidate.owner_market === null) {
      skipped_unowned.push(candidate.id)
    } else if (candidate.owner_market !== market) {
      skipped_other_market.push({ id: candidate.id, owner_market: candidate.owner_market })
    } else {
      link.push(candidate.id)
    }
  }

  return { target: market, link, skipped_other_market, skipped_unowned }
}
