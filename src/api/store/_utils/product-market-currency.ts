/**
 * One currency decision for every seller-product money write.
 *
 * Product prices are commerce data, so their currency follows the owning seller's
 * operating market. A request body may restate that currency for compatibility, but
 * it may never choose a different one.
 */

import { MARKETS, type MarketCode } from '../../../lib/markets'
import { requireSellerOperatingMarket } from '../../../lib/seller-market'

export interface SellerProductMoneyContext {
  readonly market: MarketCode
  readonly currency_code: string
}

export type SellerProductPriceAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 422; readonly message: string }

/**
 * Admission for a seller-product CREATE's native price rows.
 *
 * MX keeps its legacy optional-price behaviour unchanged. Once the US marketplace
 * is active, however, an ordinary US listing without a real positive integer USD
 * amount would become publicly discoverable with no buyable price. Refuse that
 * request before the product workflow (or any other write) runs. Dimensioned
 * listings use `variant_prices`; every generated US row is held to the same rule.
 */
export function admitSellerProductCreatePrice(
  market: MarketCode,
  input: {
    readonly price_cents?: number | null
    readonly option_dimensions?: readonly unknown[]
    readonly variant_prices?: Readonly<Record<string, number>>
  },
): SellerProductPriceAdmission {
  if (market !== 'us') return { ok: true }

  const prices = input.option_dimensions === undefined
    ? [input.price_cents]
    : Object.values(input.variant_prices ?? {})
  if (prices.length === 0 || prices.some((price) =>
    typeof price !== 'number' || !Number.isInteger(price) || price <= 0)) {
    return {
      ok: false,
      status: 422,
      message: 'US marketplace products require a positive integer USD price in cents.',
    }
  }
  return { ok: true }
}

export class SellerProductCurrencyMismatchError extends Error {
  readonly requested: string
  readonly expected: string

  constructor(requested: string, expected: string) {
    super(
      `La moneda "${requested.toUpperCase()}" no corresponde al mercado de la tienda. ` +
      `Usa ${expected.toUpperCase()}.`,
    )
    this.name = 'SellerProductCurrencyMismatchError'
    this.requested = requested
    this.expected = expected
  }
}

export function resolveSellerProductMoneyContext(
  seller: unknown,
  requestedCurrency?: unknown,
): SellerProductMoneyContext {
  const market = requireSellerOperatingMarket(seller)
  const currency_code = MARKETS[market].currency_code

  if (requestedCurrency !== undefined && requestedCurrency !== null) {
    const requested = typeof requestedCurrency === 'string'
      ? requestedCurrency.trim().toLowerCase()
      : String(requestedCurrency).trim().toLowerCase()
    if (requested && requested !== currency_code) {
      throw new SellerProductCurrencyMismatchError(requested, currency_code)
    }
  }

  return { market, currency_code }
}
