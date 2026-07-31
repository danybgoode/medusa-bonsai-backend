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
 * TWO CHANNELS PER MARKET (owned-shop-operating-channel epic, D2 · S2.2 — SHIPPED and
 * live in production as of Sprint 2: the MX operating channel exists, every product is
 * backfilled into it, and the storefront's publishable key resolves through it).
 *
 * Every product an MX seller creates joins the market's **operating channel** — the
 * channel that carries BUYABILITY. A product being published into the country
 * marketplace ADDITIONALLY joins the **marketplace channel**, which stays publication
 * truth and nothing else. Marketplace membership is therefore a strict SUBSET of
 * operating membership, permanently (D2), and that superset property is exactly what
 * lets the storefront's publishable key hold a single channel (D3).
 *
 * WHY BOTH, AND WHY NEITHER IS OPTIONAL:
 *   · operating missing ⇒ the product cannot be bought at all — the publishable key
 *     resolves through the operating channel (D3, live since S2). Creating it anyway
 *     would produce a listing that renders and 404s at checkout. So a missing
 *     operating channel REFUSES the create with an actionable message; it never
 *     falls back to "marketplace channel alone" and never to "no channel".
 *   · marketplace missing ⇒ unchanged from before: refuse. A product silently
 *     absent from `/mx` while the seller asked to publish there is a wrong claim.
 *
 * "OWNED SHOP ONLY" IS NOW BUILT (Sprint 3 · S3.1). `publish_to_market: null` means
 * *operating channel only* — buyable on the owned shop, absent from every country
 * marketplace. Because the operating channel is unconditional (the branch above always
 * resolves it first), a product created this way is NEVER channel-less: it simply
 * skips the marketplace-channel branch. The acceptance behind that is gated on
 * `catalog.owned_shop_only_enabled` (D8) — this is a security-shaped code path (it
 * changes what a caller can withhold from the marketplace), not channel membership
 * data, so unlike the backfill/key-move it IS flag-gated. With the flag OFF, `null`
 * is refused exactly as it always was, so an older client's behaviour is unchanged
 * until the flag flips.
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
   * `null` ⇒ "owned shop only" (S3.1) ⇒ operating channel alone, no marketplace
   *   channel. Gated on `ownedShopOnlyEnabled`; refused when that is false, so an
   *   older client's behaviour is unchanged until the flag flips (D8).
   */
  readonly requested?: MarketCode | null
  /** The owning seller's `metadata.operating_market`, already validated. */
  readonly sellerMarket: MarketCode
  /**
   * `catalog.owned_shop_only_enabled` (D8), resolved by the CALLER before this
   * function runs — this file stays pure (no container, no `isEnabled()`), exactly
   * like `checkout-admission.ts`'s `owned_shop_only_enabled` input. Omitted ⇒ `false`,
   * i.e. the flag-off / pre-Sprint-3 behaviour — a caller that forgets to resolve the
   * flag gets the STRICTER answer, never the looser one.
   */
  readonly ownedShopOnlyEnabled?: boolean
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
      /** Publication truth. `null` for an owned-shop-only product (S3.1). */
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
  const ownedShopOnly = input.requested === null

  // Not stated ⇒ the SELLER's market. `null` (owned-shop-only) never carries a
  // market of its own — it always means "MY market's operating channel, no
  // marketplace" — so it resolves to `sellerMarket` exactly like "not stated" does.
  const target = ownedShopOnly || input.requested === undefined
    ? sellerMarket
    : requireMarket(input.requested).code

  if (ownedShopOnly) {
    // D8: the acceptance of `null` is a security-shaped code path (it lets a caller
    // withhold a product from the marketplace entirely) and is gated behind
    // `catalog.owned_shop_only_enabled`. OFF ⇒ refuse exactly as before Sprint 3, so
    // a client written against the pre-epic contract is unaffected until the flag
    // flips. This is the ONLY branch that reads the flag — every other value of
    // `requested` behaves exactly as it always has, flag or no flag.
    if (!input.ownedShopOnlyEnabled) {
      return {
        status: 'refused',
        market: sellerMarket,
        http_status: 422,
        message: 'La publicación "solo tienda propia" todavía no está disponible en tu cuenta. ' +
          'Omite publish_to_market para publicar en el marketplace de tu tienda.',
      }
    }

    // The operating channel is resolved with the EXACT same rule as the marketplace
    // path below — unconfigured/no_resource both refuse (never fall back to the
    // marketplace channel, which would silently publish an owned-shop-only product
    // into the country marketplace: the opposite of what the seller asked for). D2
    // guarantees the result — when it resolves — is never empty: this is the only
    // channel an owned-shop-only product joins, and it is always populated.
    const operating = resolveOperatingChannelForMarket(sellerMarket, env)
    if (operating.status !== 'resolved') {
      return {
        status: 'refused',
        market: sellerMarket,
        http_status: 503,
        message: operating.status === 'unconfigured'
          ? `${operating.reason} Sin el canal operativo el producto no se puede crear en ningún estado; ` +
            'configura MEDUSA_MX_OPERATING_CHANNEL_ID en el backend.'
          : `Market "${sellerMarket}" has no operating channel in any environment: ${operating.reason}`,
      }
    }

    return {
      status: 'channels',
      market: sellerMarket,
      operating_channel_id: operating.id,
      marketplace_channel_id: null,
      channel_ids: [operating.id],
    }
  }

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

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PUBLISH / UNPUBLISH AN EXISTING PRODUCT (Sprint 3 · S3.2, D11).
 *
 * `planProductPublication` above decides the FULL channel set at CREATE time.
 * This is its update-time sibling: a product already exists (and, by D2, is
 * already in its operating channel — every create path guarantees that), and the
 * only question is whether the MARKETPLACE channel should be added or removed.
 * The operating channel is NEVER touched here — that is what makes "unpublish"
 * safe: the product stays buyable on the owned shop throughout, so there is no
 * window in which it sits in zero channels (D11, D2).
 *
 * Same `requested: MarketCode | null` shape as create, for surface parity:
 *   'mx'  — publish. Adds the marketplace channel. Same "your own market only,
 *           and only an open one" rules as create.
 *   null  — unpublish. Removes ONLY the marketplace channel.
 *
 * GATED ON THE FLAG IN BOTH DIRECTIONS (D8's "everything seller-facing in this
 * sprint"), not just the `null` direction: with `catalog.owned_shop_only_enabled`
 * OFF, the storefront's checkout-admission seam still requires marketplace
 * membership to admit a cart line (D8's flag-off branch in `checkout-admission.ts`).
 * Letting a seller unpublish while that gate is OFF would produce a product that
 * LOOKS fine (still in its operating channel, still renders on the owned shop) but
 * cannot complete checkout through the storefront's default gate — exactly the
 * "looks healthy, fails at the money step" shape this epic exists to prevent.
 * Publish is gated too, for the same reason and for symmetry: a capability that is
 * reversible in one direction but not the other is a trap, not a kill-switch.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export interface PublicationChangeRequest {
  /** 'mx' (or the seller's market) to publish; `null` to unpublish. */
  readonly requested: MarketCode | null
  /** The owning seller's `metadata.operating_market`, already validated. */
  readonly sellerMarket: MarketCode
  /** `catalog.owned_shop_only_enabled` (D8), resolved by the caller. Omitted ⇒ `false`. */
  readonly ownedShopOnlyEnabled?: boolean
}

export type PublicationChangePlan =
  | { readonly status: 'add_marketplace'; readonly market: MarketCode; readonly marketplace_channel_id: string }
  | { readonly status: 'remove_marketplace'; readonly market: MarketCode; readonly marketplace_channel_id: string }
  | { readonly status: 'refused'; readonly market: MarketCode; readonly http_status: 422 | 423 | 503; readonly message: string }

export function planPublicationChange(
  input: PublicationChangeRequest,
  env: MarketMedusaEnv,
): PublicationChangePlan {
  const sellerMarket = requireMarket(input.sellerMarket).code

  if (!input.ownedShopOnlyEnabled) {
    // 423 (Locked) — matches the existing kill-switch-style refusal shape used
    // elsewhere in this repo (`catalog.bulk_enabled`, `catalog.inventory_channels_
    // enabled`) for "this capability exists but is not turned on for you", as
    // distinct from a 422 caller-input error or a 503 infra outage.
    return {
      status: 'refused',
      market: sellerMarket,
      http_status: 423,
      message: 'Publicar o despublicar del marketplace todavía no está disponible en tu cuenta.',
    }
  }

  if (input.requested === null) {
    // Unpublish. ONLY the marketplace channel — the operating channel (D2) is never
    // named here, so there is structurally no code path in this function that could
    // remove it.
    const marketplace = resolveMarketplaceChannelForMarket(sellerMarket, env)
    if (marketplace.status !== 'resolved') {
      return {
        status: 'refused',
        market: sellerMarket,
        http_status: 503,
        message: marketplace.status === 'unconfigured'
          ? marketplace.reason
          : `Market "${sellerMarket}" has no marketplace channel configured.`,
      }
    }
    return { status: 'remove_marketplace', market: sellerMarket, marketplace_channel_id: marketplace.id }
  }

  // Publish. The same per-country rules as create: only your own market ("mx"
  // cannot be smuggled around by naming a different one), and only an open one.
  const target = requireMarket(input.requested).code
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
    return {
      status: 'refused',
      market: record.code,
      http_status: 422,
      message: `El marketplace de ${record.code.toUpperCase()} todavía no está abierto ` +
        `(${record.marketplace_status}). Tu tienda existe, pero aún no se puede publicar ahí.`,
    }
  }
  const marketplace = resolveMarketplaceChannelForMarket(target, env)
  if (marketplace.status !== 'resolved') {
    return {
      status: 'refused',
      market: record.code,
      http_status: 503,
      message: marketplace.status === 'unconfigured'
        ? marketplace.reason
        : `Market "${record.code}" has no marketplace channel configured.`,
    }
  }
  return { status: 'add_marketplace', market: record.code, marketplace_channel_id: marketplace.id }
}
