/**
 * product-publication.ts — where a seller-product create STATES its marketplace
 * publication intent instead of blindly attaching whatever channel is lying around.
 *
 * Before this seam, every create did `sales_channels: [{ id: MEDUSA_SALES_CHANNEL_ID
 * ?? store.default_sales_channel_id }]` — one hard-coded channel for one hard-coded
 * country. That is fine while exactly one market exists and becomes a silent
 * cross-market publication the moment a second one does. Story 1.3: operating a shop
 * and joining Miyagi Markets are independent choices, so the call site must say which
 * it means.
 *
 * BEHAVIOUR IS UNCHANGED for the default path, deliberately: an unspecified intent is
 * `DEFAULT_MARKET` (`mx`), which resolves to the same env var and the same store
 * default fallback as before. What is new is that (a) a caller can now ask for
 * owned-shop-only, and (b) a market whose marketplace is not open REFUSES rather
 * than falling back to Mexico's channel.
 */

import {
  DEFAULT_MARKET,
  type MarketCode,
  MARKETS,
  isMarketplaceOpen,
  requireMarket,
} from '../../../lib/markets'
import {
  type MarketMedusaEnv,
  resolveMarketplaceChannelForMarket,
} from '../../../lib/market-medusa'

/**
 * What the caller means by "publish".
 *
 * `owned_shop_only` is a first-class intent, not the absence of one: a product with
 * no marketplace channel is still fully visible on its own shop, subdomain, custom
 * domain and embed (D4). It is invisible only to the country marketplace.
 */
export type PublicationIntent =
  | { readonly kind: 'marketplace'; readonly market: MarketCode }
  | { readonly kind: 'owned_shop_only' }

/**
 * Normalise a caller's `publish_to_market` field into an intent.
 *
 * `undefined` ⇒ marketplace/`DEFAULT_MARKET` — the pre-launch compatibility default
 * that keeps every existing seller/agent create byte-identical to today.
 * `null` ⇒ owned-shop only (an explicit choice, spelled differently from "did not
 * say", because those must not be the same value).
 * Anything unrecognised throws `UnknownMarketError`.
 */
export function resolvePublicationIntent(requested: MarketCode | null | undefined): PublicationIntent {
  if (requested === undefined) return { kind: 'marketplace', market: DEFAULT_MARKET }
  if (requested === null) return { kind: 'owned_shop_only' }
  return { kind: 'marketplace', market: requireMarket(requested).code }
}

/**
 * How the create path should resolve a Sales Channel for that intent.
 *
 *   channel        — link this exact channel id.
 *   none           — link NO channel. Owned-shop only.
 *   store_default  — MX legacy path: the marketplace is open but
 *                    `MEDUSA_SALES_CHANNEL_ID` is unset, so fall back to
 *                    `store.default_sales_channel_id` exactly as before. Kept
 *                    because a product in NO channel 404s on the channel-scoped
 *                    `/store/products` endpoint and its checkout fails with
 *                    "Product not found" — the original reason this attachment
 *                    exists at all. The fallback is an I/O read, so the shell
 *                    performs it; this pure function only says that it should.
 *   refused        — the requested market's marketplace is not open (`us` is
 *                    `invitation`). We do NOT fall back: handing a non-Mexico shop
 *                    the Mexico channel would publish it into the wrong country's
 *                    marketplace and let it inherit Mexico's Stripe/shipping rails.
 */
export type PublicationChannelPlan =
  | { readonly status: 'channel'; readonly market: MarketCode; readonly channel_id: string }
  | { readonly status: 'none'; readonly reason: string }
  | { readonly status: 'store_default'; readonly market: MarketCode; readonly reason: string }
  | { readonly status: 'refused'; readonly market: MarketCode; readonly message: string }

export function planPublicationChannel(
  intent: PublicationIntent,
  env: MarketMedusaEnv,
): PublicationChannelPlan {
  if (intent.kind === 'owned_shop_only') {
    return {
      status: 'none',
      reason: 'Owned-shop only — the product is deliberately not published into any country marketplace.',
    }
  }

  const record = MARKETS[intent.market]
  if (!isMarketplaceOpen(intent.market)) {
    return {
      status: 'refused',
      market: record.code,
      message: `El marketplace de ${record.code.toUpperCase()} no está abierto (${record.marketplace_status}). ` +
        'No se puede publicar ahí todavía.',
    }
  }

  const channel = resolveMarketplaceChannelForMarket(intent.market, env)
  if (channel.status === 'resolved') {
    return { status: 'channel', market: record.code, channel_id: channel.id }
  }
  return {
    status: 'store_default',
    market: record.code,
    reason: channel.status === 'unconfigured'
      ? channel.reason
      : `Market "${record.code}" has no marketplace channel configured.`,
  }
}
