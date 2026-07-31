/**
 * checkout-admission.ts — the CHECKOUT admission boundary: may this product id enter
 * a cart in this market? (owned-shop-operating-channel epic, D7 · S2.3)
 *
 * ── WHY A SECOND BOUNDARY EXISTS AT ALL ────────────────────────────────────────
 * The storefront's `lib/cart.ts` → `resolveCheckoutLines` admits every checkout line
 * through `GET /store/listings/:id?market=mx` — the MARKETPLACE detail endpoint. That
 * gate asks "is this product PUBLISHED to the mx marketplace?", which was the right
 * question while publication and buyability were the same fact. They are not any
 * more: an owned-shop-only product is deliberately absent from the marketplace and
 * 404s there, so no amount of backend channel work makes it buyable while that gate
 * stands.
 *
 * `GET /store/listings/:id` is therefore left EXACTLY as it is (epic E3 — marketplace
 * publication semantics are not reopened), and the relaxation lives here, in its own
 * route, with its own single rule. It is deliberately NOT an option flag on the
 * existing read boundary: a guard the caller can switch off is not a guard.
 *
 * ── THE ONE QUESTION THIS ANSWERS ──────────────────────────────────────────────
 * Is this product a member of THIS MARKET'S OPERATING CHANNEL — the channel that
 * carries buyability (D2) and that the storefront's publishable key resolves through
 * after D3? Nothing else. Admission widens by exactly one fact: *buyable on its own
 * shop*. It never widens to "any product id".
 *
 * ── WHAT IS STILL PROVEN, AND WHY EACH ONE IS HERE ─────────────────────────────
 *   · PUBLISHED. Channel membership is not publish state, and D6 deliberately links
 *     DRAFTS into the operating channel so a product published later is already
 *     buyable. Without this check, that decision would make every draft purchasable.
 *   · OWNED BY A SELLER OPERATING IN THIS MARKET. Per-object authorization (AGENTS
 *     rule 4): the caller supplies the product id, so the market scoping must be
 *     proven against the OWNING SELLER, not against the caller's assertion. An
 *     unresolvable owner is refused, not adopted.
 *   · NOT A HIDDEN / SUPPORT / PRINT-PLACEMENT PRODUCT. Exactly what
 *     `/store/listings/:id` refuses today. Admitting them here would be a widening
 *     nobody asked for, hidden inside a change that is about something else.
 *   · MARKETPLACE MEMBERSHIP, while `catalog.owned_shop_only_enabled` is OFF (D8).
 *     With the flag OFF this seam is exactly as strict as the gate it replaces, so
 *     the route is safe to deploy before the flip and the flip's entire effect is
 *     "stop requiring marketplace publication".
 *
 * ── THREE STATES, NEVER TWO ────────────────────────────────────────────────────
 * `unknown` 400 / `closed` 404 / `unavailable` 503, the same shape as
 * `market-read.ts`. An unresolvable operating channel is an OUTAGE (503) and never a
 * fallback to admitting everything — an unfiltered answer on a money path is
 * indistinguishable from a correct one, which is how a boundary silently stops
 * existing.
 *
 * Pure. No container, no database, no `process.env` — the route is the I/O shell.
 */

import {
  type MarketCode,
  type MarketplaceStatus,
  MARKETS,
  UnknownMarketError,
  isMarketplaceOpen,
} from '../../../lib/markets'
import {
  type MarketMedusaEnv,
  resolveMarketplaceChannelForMarket,
  resolveOperatingChannelForMarket,
} from '../../../lib/market-medusa'
import {
  type MarketUnavailableBody,
  productInMarketplaceChannel,
  resolveRequestedMarket,
} from './market-read'
import { isHiddenCatalogProduct } from './support'

/**
 * The gate a checkout-admission read passes before it queries anything.
 *
 * `marketplace_channel_id` rides along because the flag-OFF path needs it and because
 * the response reports both memberships — a reviewer reading the payload can see the
 * superset rule (D2) holding, rather than taking it on trust.
 */
export type CheckoutAdmissionGate =
  | {
      readonly ok: true
      readonly market: MarketCode
      readonly operating_channel_id: string
      readonly marketplace_channel_id: string | null
    }
  | {
      readonly ok: false
      readonly kind: 'unknown' | 'closed' | 'unavailable'
      readonly status: number
      readonly body: MarketUnavailableBody
    }

function refuse(
  kind: 'unknown' | 'closed' | 'unavailable',
  status: number,
  body: MarketUnavailableBody,
): CheckoutAdmissionGate {
  return { ok: false, kind, status, body }
}

/**
 * Decide whether a checkout admission read may proceed, and against which channel.
 *
 * NOTE ON `us` AND WHY THERE ARE TWO REFUSALS FOR IT: the operating-channel check
 * runs FIRST, so `us` is refused for the epic-correct reason — it has no operating
 * channel in ANY environment (`market-medusa.ts`: no env key, structural). The
 * `isMarketplaceOpen` check below it is a second, deliberately redundant no-US-
 * commerce guard (epic E3: no US channel, Region, currency, payment or shipping
 * exists). It is kept because removing a guard is a widening, and today the two
 * always agree. When a market ever needs owned-shop buyability WITHOUT an open
 * country marketplace — which is the direction this epic points — that second check
 * is the one to revisit, deliberately, with its own decision. Do not delete it as
 * redundant noise on the way past.
 */
export function resolveCheckoutAdmissionGate(
  rawMarket: unknown,
  env: MarketMedusaEnv,
): CheckoutAdmissionGate {
  const requested = resolveRequestedMarket(rawMarket)
  if (typeof requested !== 'string') {
    return refuse('unknown', 400, {
      unavailable: true,
      market_code: typeof rawMarket === 'string' ? rawMarket : null,
      marketplace_status: null,
      reason: 'unknown_market',
      message: (requested.error as UnknownMarketError).message,
    })
  }

  const record = MARKETS[requested]
  const status: MarketplaceStatus = record.marketplace_status

  const operating = resolveOperatingChannelForMarket(requested, env)
  if (operating.status === 'no_resource') {
    return refuse('closed', 404, {
      unavailable: true,
      market_code: record.code,
      marketplace_status: status,
      reason: 'market_has_no_operating_channel',
      message: `The ${record.code.toUpperCase()} market has no operating Sales Channel in any environment, ` +
        'so nothing can be bought there. This is structural, not a configuration gap.',
    })
  }
  if (operating.status === 'unconfigured') {
    // Operator fault, and it fails CLOSED and LOUDLY. Admitting everything because we
    // could not address the channel would turn a misconfigured deploy into an open
    // money path.
    return refuse('unavailable', 503, {
      unavailable: true,
      market_code: record.code,
      marketplace_status: status,
      reason: 'operating_channel_unavailable',
      message: operating.reason,
    })
  }

  if (!isMarketplaceOpen(requested)) {
    // See the function header: redundant with the `no_resource` branch today, kept on
    // purpose (E3 — no US commerce of any kind).
    return refuse('closed', 404, {
      unavailable: true,
      market_code: record.code,
      marketplace_status: status,
      reason: 'marketplace_not_open',
      message: `The ${record.code.toUpperCase()} market is "${status}" — it has no commerce rails.`,
    })
  }

  const marketplace = resolveMarketplaceChannelForMarket(requested, env)
  return {
    ok: true,
    market: record.code,
    operating_channel_id: operating.id,
    marketplace_channel_id: marketplace.status === 'resolved' ? marketplace.id : null,
  }
}

/** A product row carrying only what the decision reads. */
export interface AdmissionProductRow {
  readonly id?: string | null
  readonly status?: string | null
  readonly metadata?: Record<string, unknown> | null
  readonly sales_channels?: ReadonlyArray<{ id?: string } | null | undefined> | null
}

/**
 * Why a product was refused. INTERNAL — the route answers every refusal with one
 * indistinguishable 404, exactly like `/store/listings/:id` does, because a checkout
 * gate is not entitled to teach a caller which of its rules it tripped. These names
 * exist so the specs can assert the RULE that fired, not merely that something did.
 */
export type AdmissionRefusal =
  | 'not_found'
  | 'id_mismatch'
  | 'not_published'
  | 'hidden_product'
  | 'not_in_operating_channel'
  | 'not_in_marketplace_channel'
  | 'owner_unresolved'
  | 'owner_other_market'

export type CheckoutAdmissionDecision =
  | {
      readonly admitted: true
      readonly product_id: string
      readonly in_operating_channel: true
      readonly in_marketplace_channel: boolean
    }
  | { readonly admitted: false; readonly refusal: AdmissionRefusal }

export interface CheckoutAdmissionInput {
  /** The id the CALLER asked about — never the row's own id. */
  readonly requested_product_id: string
  readonly product: AdmissionProductRow | null | undefined
  readonly operating_channel_id: string
  /** `null` when the market's marketplace channel is unaddressable. */
  readonly marketplace_channel_id: string | null
  /** The OWNING seller's operating market; `null` when it could not be resolved. */
  readonly owner_market: MarketCode | null
  readonly market: MarketCode
  /** `catalog.owned_shop_only_enabled` (D8). OFF ⇒ marketplace membership is still required. */
  readonly owned_shop_only_enabled: boolean
}

/**
 * The whole decision, pure.
 *
 * Order is chosen so the CHEAPEST and most fundamental facts refuse first, but every
 * branch returns the same HTTP answer at the route, so ordering leaks nothing.
 */
export function decideCheckoutAdmission(input: CheckoutAdmissionInput): CheckoutAdmissionDecision {
  const {
    requested_product_id: requestedId,
    product,
    operating_channel_id: operatingChannelId,
    marketplace_channel_id: marketplaceChannelId,
    owner_market: ownerMarket,
    market,
    owned_shop_only_enabled: ownedShopOnly,
  } = input

  if (!product || typeof product.id !== 'string' || !product.id) {
    return { admitted: false, refusal: 'not_found' }
  }
  // The row must be the row that was ASKED about. A filtered query should make this
  // unreachable; it is asserted anyway because the whole class of admission bug this
  // codebase has shipped is "the proof and the purchase named different objects".
  if (product.id !== requestedId) {
    return { admitted: false, refusal: 'id_mismatch' }
  }
  if (product.status !== 'published') {
    // D6 links DRAFTS into the operating channel deliberately. Membership is
    // therefore NOT publish state, and a draft must not be buyable.
    return { admitted: false, refusal: 'not_published' }
  }
  // TRUTHY, not `=== true`, deliberately: `/store/listings/:id` refuses on
  // `metadata?.is_print_placement` being truthy, and a stricter test here would
  // ADMIT a placement whose flag was stored as `1` or `"true"` — a widening smuggled
  // in by a tidier-looking comparison. Match the gate being replaced, exactly.
  if ((product.metadata as Record<string, unknown> | null)?.is_print_placement
    || isHiddenCatalogProduct(product.metadata)) {
    return { admitted: false, refusal: 'hidden_product' }
  }

  // Per-object authorization, proven against the OWNING SELLER (AGENTS rule 4).
  if (!ownerMarket) {
    // Fail closed. "I could not resolve the owner" is not "the owner is fine" — an
    // orphaned product is a data-repair job, never something a money path adopts.
    return { admitted: false, refusal: 'owner_unresolved' }
  }
  if (ownerMarket !== market) {
    return { admitted: false, refusal: 'owner_other_market' }
  }

  const inOperating = productInMarketplaceChannel(product, operatingChannelId)
  if (!inOperating) {
    return { admitted: false, refusal: 'not_in_operating_channel' }
  }

  const inMarketplace = !!marketplaceChannelId
    && productInMarketplaceChannel(product, marketplaceChannelId)

  if (!ownedShopOnly && !inMarketplace) {
    // FLAG OFF ⇒ behave exactly as the marketplace gate this seam replaces (D8).
    // Note this also refuses when `marketplace_channel_id` is null: an unaddressable
    // marketplace channel means we cannot PROVE publication, and on a money path
    // "cannot prove" is "no".
    return { admitted: false, refusal: 'not_in_marketplace_channel' }
  }

  return {
    admitted: true,
    product_id: product.id,
    in_operating_channel: true,
    in_marketplace_channel: inMarketplace,
  }
}

/**
 * The graph fields the admission read must request.
 *
 * A constant, not a literal at the call site: the decision is only as correct as the
 * field that feeds it, and a route that forgot `sales_channels.id` would see every
 * product as channel-less and refuse the entire catalog.
 */
export const CHECKOUT_ADMISSION_FIELDS = [
  'id',
  'status',
  'metadata',
  'sales_channels.id',
] as const

/** The exact 404 body every product-level refusal returns. Uniform on purpose. */
export const ADMISSION_NOT_FOUND_MESSAGE = 'Listing not found'
