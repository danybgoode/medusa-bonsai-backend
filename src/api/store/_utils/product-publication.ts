/**
 * product-publication.ts — where a seller-product create STATES which country
 * marketplace it is publishing into, instead of blindly attaching whatever channel is
 * lying around.
 *
 * Before this seam, every create did `sales_channels: [{ id: MEDUSA_SALES_CHANNEL_ID
 * ?? store.default_sales_channel_id }]` — one fallback chain for one hard-coded
 * country. Fine while exactly one market exists; a silent cross-market publication the
 * moment a second one does.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THERE IS NO "OWNED SHOP ONLY" OPTION, AND THAT IS DELIBERATE.
 *
 * An earlier draft of this file let a caller pass `publish_to_market: null` to create
 * a product with NO sales channel — visible on the shop, absent from the marketplace.
 * It renders. It cannot be bought: a channel-less product 404s on the channel-scoped
 * `/store/products` endpoint and its checkout fails with "Product not found".
 *
 * Making it buyable needs a model this epic does not build: TWO channels per market —
 * an **operating channel** that every product in that market joins (which is what
 * makes it purchasable) and the **marketplace channel** that is publication truth.
 * That means a new production Sales Channel, a publishable-key change and a full
 * product backfill. It is a real follow-up, not a line in this PR, and none of the
 * epic's ten stories asks for it.
 *
 * So the capability is absent rather than half-built: a listing you can create but
 * never sell is worse than one you cannot create. If you are here to re-add it, build
 * the operating channel first.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The other rule this file enforces: the market comes from the SELLER, not from a
 * platform-wide default. `DEFAULT_MARKET` describes the pre-launch *legacy read*
 * population; using it as a write default would publish a US shop's product into the
 * Mexico marketplace and hand it Mexico's Stripe/shipping rails — the exact thing
 * story 1.2's acceptance forbids.
 */

import {
  type MarketCode,
  MARKETS,
  isMarketplaceOpen,
  requireMarket,
} from '../../../lib/markets'
import {
  type MarketMedusaEnv,
  resolveMarketplaceChannelForMarket,
} from '../../../lib/market-medusa'

export interface PublicationRequest {
  /**
   * The market the caller explicitly asked to publish into, if any.
   *
   * `undefined` ⇒ not stated ⇒ the seller's own operating market.
   * `null` ⇒ the retired "owned shop only" value ⇒ REFUSED, loudly. It is spelled out
   * rather than folded into "not stated" so a client written against the earlier draft
   * gets an error instead of silently receiving the marketplace publication it asked
   * not to have.
   */
  readonly requested?: MarketCode | null
  /** The owning seller's `metadata.operating_market`, already validated. */
  readonly sellerMarket: MarketCode
}

/**
 * How the create path should resolve a Sales Channel.
 *
 *   channel       — link this exact market channel id.
 *   refused       — the create must not proceed. Carries an actionable message.
 */
export type PublicationChannelPlan =
  | { readonly status: 'channel'; readonly market: MarketCode; readonly channel_id: string }
  | {
      readonly status: 'refused'
      readonly market: MarketCode
      readonly http_status: 422 | 503
      readonly message: string
    }

export function planProductPublication(
  input: PublicationRequest,
  env: MarketMedusaEnv,
): PublicationChannelPlan {
  const sellerMarket = requireMarket(input.sellerMarket).code

  if (input.requested === null) {
    return {
      status: 'refused',
      market: sellerMarket,
      http_status: 422,
      message: 'La publicación "solo tienda propia" no está disponible: un producto sin canal de venta ' +
        'no se puede comprar. Omite publish_to_market para publicar en el marketplace de tu tienda.',
    }
  }

  // Not stated ⇒ the SELLER's market. Never a platform-wide default.
  const target = input.requested === undefined
    ? sellerMarket
    : requireMarket(input.requested).code

  // A seller may only publish into its own operating market. v1 has no cross-border
  // commerce of any kind (an explicit epic non-goal), so a mismatch is always an
  // error — and without this clause the "a US shop cannot publish to MX" rule below
  // would be bypassable by simply naming `mx` in the request body.
  if (target !== sellerMarket) {
    return {
      status: 'refused',
      market: target,
      http_status: 422,
      message: `Tu tienda opera en ${sellerMarket.toUpperCase()} y no puede publicar en el marketplace de ` +
        `${target.toUpperCase()}. La publicación es específica de cada país.`,
    }
  }

  const record = MARKETS[target]
  if (!isMarketplaceOpen(target)) {
    // A US seller cannot create a marketplace product. That is CORRECT, not a gap:
    // US commerce (money, shipping, tax, KYC) is an explicit non-goal of this epic,
    // and story 3.3 requires exactly this shape — a write that would enable
    // unsupported US commerce fails with an actionable message rather than quietly
    // succeeding against Mexico's rails.
    return {
      status: 'refused',
      market: record.code,
      http_status: 422,
      message: `El marketplace de ${record.code.toUpperCase()} todavía no está abierto ` +
        `(${record.marketplace_status}). Tu tienda existe, pero aún no se puede publicar ahí.`,
    }
  }

  const channel = resolveMarketplaceChannelForMarket(target, env)
  if (channel.status === 'resolved') {
    return { status: 'channel', market: record.code, channel_id: channel.id }
  }
  return {
    status: 'refused',
    market: record.code,
    http_status: 503,
    message: channel.status === 'unconfigured'
      ? channel.reason
      : `Market "${record.code}" has no marketplace channel configured.`,
  }
}
