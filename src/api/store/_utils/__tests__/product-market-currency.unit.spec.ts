import {
  SellerProductCurrencyMismatchError,
  resolveSellerProductMoneyContext,
} from '../product-market-currency'

describe('resolveSellerProductMoneyContext', () => {
  it.each([
    ['mx', 'mxn'],
    ['us', 'usd'],
  ] as const)('derives %s seller prices from the registry as %s', (market, currency) => {
    expect(resolveSellerProductMoneyContext({
      metadata: { operating_market: market },
    })).toEqual({ market, currency_code: currency })
  })

  it('accepts a caller restating the registry currency case-insensitively', () => {
    expect(resolveSellerProductMoneyContext(
      { metadata: { operating_market: 'us' } },
      ' USD ',
    ).currency_code).toBe('usd')
  })

  it('refuses a caller-selected foreign currency', () => {
    expect(() => resolveSellerProductMoneyContext(
      { metadata: { operating_market: 'mx' } },
      'usd',
    )).toThrow(SellerProductCurrencyMismatchError)
  })

  it('fails closed on an invalid stored seller market', () => {
    expect(() => resolveSellerProductMoneyContext({
      metadata: { operating_market: 'es-MX' },
    })).toThrow(/Unsupported market/)
  })
})
