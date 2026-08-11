import {
  admitSellerProductCreatePrice,
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

describe('admitSellerProductCreatePrice — active US marketplace write boundary', () => {
  it.each([undefined, null, 0, -1, 100.5])(
    'refuses an ordinary US create with non-positive/non-integer price %p',
    (price_cents) => {
      expect(admitSellerProductCreatePrice('us', { price_cents })).toEqual({
        ok: false,
        status: 422,
        message: expect.stringMatching(/positive integer USD price/),
      })
    },
  )

  it('admits a positive integer US price', () => {
    expect(admitSellerProductCreatePrice('us', { price_cents: 2500 })).toEqual({ ok: true })
  })

  it('requires every generated US variant price to be a positive integer', () => {
    expect(admitSellerProductCreatePrice('us', {
      option_dimensions: [{ title: 'Size', values: ['S', 'M'] }],
      variant_prices: { 'Size:S': 2500, 'Size:M': 3000 },
    })).toEqual({ ok: true })
    expect(admitSellerProductCreatePrice('us', {
      option_dimensions: [{ title: 'Size', values: ['S', 'M'] }],
      variant_prices: { 'Size:S': 2500, 'Size:M': 0 },
    }).ok).toBe(false)
  })

  it('does not change legacy MX optional-price admission', () => {
    expect(admitSellerProductCreatePrice('mx', {})).toEqual({ ok: true })
    expect(admitSellerProductCreatePrice('mx', { price_cents: 0 })).toEqual({ ok: true })
  })
})
