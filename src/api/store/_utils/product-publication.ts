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
 * TWO CHANNELS PER MARKET (owned-shop-operating-channel epic, D2 · S2.2).
 *
 * Every product an MX seller creates joins the market's **operating channel** — the
 * channel that carries BUYABILITY. A product being published into the country
 * marketplace ADDITIONALLY joins the **marketplace channel**, which stays publication
 * truth and nothing else. Marketplace membership is therefore a strict SUBSET of
 * operating membership, permanently (D2), and that superset property is exactly what
 * lets the storefront's publishable key hold a single channel (D3).
 *
 * WHY BOTH, AND WHY NEITHER IS OPTIONAL:
 *   · operating missing ⇒ the product cannot be bought at all once the publishable
 *     key resolves through the operating channel (D3). Creating it anyway would
 *     produce a listing that renders and 404s at checkout — the exact half-built
 *     capability the previous version of this header refused to ship. So a missing
 *     operating channel REFUSES the create with an actionable message; it never
 *     falls back to "marketplace channel alone" and never to "no channel".
 *   · marketplace missing ⇒ unchanged from before: refuse. A product silently
 *     absent from `/mx` while the seller asked to publish there is a wrong claim.
 *
 * "OWNED SHOP ONLY" IS STILL REFUSED HERE — for now. `publish_to_market: null` is the
 * capability this epic exists to build, but it is Sprint 3's story (S3.1) and it is
 * gated on `catalog.owned_shop_only_enabled` (D8). Until then the refusal below
 * stands, so a client written against the earlier draft still gets an error rather
 * than silently receiving the marketplace publication it asked not to have. When S3.1
 * lands, `marketplace_channel_id: null` is the shape it fills in — the operating
 * channel is already unconditional, which is what makes that a one-branch change.
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
  resolveOperatingChannelForMarket,
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
 * How the create path should resolve its Sales Channels.
 *
 *   channels — link EVERY id in `channel_ids`. Always contains the operating
 *              channel; contains the marketplace channel too whenever the product is
 *              being published into the country marketplace (D2).
 *   refused  — the create must not proceed. Carries an actionable message.
 *
 * `channel_ids` is the ONE field a create path should read. The two named ids are
 * exposed beside it for reporting and for the specs that assert the superset rule —
 * a caller that builds its own array from them would be a second definition of "which
 * channels does a new product join", which is how the two drift.
 */
export type PublicationChannelPlan =
  | {
      readonly status: 'channels'
      readonly market: MarketCode
      /** Buyability. Never null on a non-refused plan — that is the whole point. */
      readonly operating_channel_id: string
      /** Publication truth. `null` once S3.1's owned-shop-only publication lands. */
      readonly marketplace_channel_id: string | null
      /** Deduped. The exact set to attach; never empty. */
      readonly channel_ids: readonly string[]
    }
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
  if (channel.status !== 'resolved') {
    return {
      status: 'refused',
      market: record.code,
      http_status: 503,
      message: channel.status === 'unconfigured'
        ? channel.reason
        : `Market "${record.code}" has no marketplace channel configured.`,
    }
  }

  // ── The operating channel (D2). Resolved SECOND but required just as hard. ──
  // Order matters only for which message a doubly-misconfigured environment shows,
  // and marketplace-first preserves the pre-existing one. Neither outcome proceeds.
  //
  // There is deliberately no fallback from `unconfigured` to the marketplace id:
  // `market-medusa.ts`'s own header spells out why. A product created into the
  // marketplace channel alone looks completely healthy today and becomes unbuyable
  // the instant the publishable key moves (D3) — a failure that would surface as
  // "checkout says Product not found" days later, with nothing pointing back here.
  const operating = resolveOperatingChannelForMarket(target, env)
  if (operating.status !== 'resolved') {
    return {
      status: 'refused',
      market: record.code,
      http_status: 503,
      message: operating.status === 'unconfigured'
        ? `${operating.reason} Sin el canal operativo el producto se crearía sin poder venderse; ` +
          'configura MEDUSA_MX_OPERATING_CHANNEL_ID en el backend antes de publicar.'
        : `Market "${record.code}" has no operating channel in any environment: ${operating.reason}`,
    }
  }

  return {
    status: 'channels',
    market: record.code,
    operating_channel_id: operating.id,
    marketplace_channel_id: channel.id,
    // Deduped: a misconfiguration that points both env vars at ONE channel must
    // produce one link, not a duplicate link row. The backfill/prune history in this
    // repo is entirely about duplicate and dangling link rows — do not make more.
    channel_ids: [...new Set([operating.id, channel.id])],
  }
}
