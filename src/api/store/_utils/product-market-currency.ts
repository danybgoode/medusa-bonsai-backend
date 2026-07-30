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
