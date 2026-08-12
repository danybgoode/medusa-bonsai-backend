import {
  findSellerByStripeAccount,
  sellerStripeAccountId,
} from '../seller-stripe-lookup'

const sellerWith = (id: string, account?: string) => ({
  id,
  metadata: account ? { settings: { stripe: { account_id: account } } } : {},
})

/** A paging fetcher over a fixed population, counting how many pages were pulled. */
function pagedSource(sellers: ReturnType<typeof sellerWith>[]) {
  const calls: number[] = []
  return {
    calls,
    fetch: async (skip: number, take: number) => {
      calls.push(skip)
      return sellers.slice(skip, skip + take)
    },
  }
}

describe('findSellerByStripeAccount', () => {
  it('finds a seller on the first page', async () => {
    const src = pagedSource([sellerWith('s1', 'acct_a'), sellerWith('s2', 'acct_b')])
    const hit = await findSellerByStripeAccount('acct_b', src.fetch, 10)
    expect(hit?.id).toBe('s2')
    expect(src.calls).toEqual([0])
  })

  // The regression that motivated this: the old flat `take: 500` silently stopped
  // finding sellers past the cap, and reported it as "not one of ours".
  it('finds a seller BEYOND the old 500 cap', async () => {
    const many = Array.from({ length: 640 }, (_, i) => sellerWith(`s${i}`, `acct_${i}`))
    const src = pagedSource(many)
    const hit = await findSellerByStripeAccount('acct_612', src.fetch, 200)
    expect(hit?.id).toBe('s612')
    expect(src.calls).toEqual([0, 200, 400, 600])
  })

  it('returns null when the account belongs to nobody, having scanned every page', async () => {
    const src = pagedSource(Array.from({ length: 250 }, (_, i) => sellerWith(`s${i}`, `acct_${i}`)))
    expect(await findSellerByStripeAccount('acct_nope', src.fetch, 100)).toBeNull()
    expect(src.calls).toEqual([0, 100, 200])
  })

  it('stops on a short page rather than spinning forever', async () => {
    let calls = 0
    const fetch = async () => { calls += 1; return [sellerWith('s1', 'acct_a')] }
    expect(await findSellerByStripeAccount('acct_zzz', fetch, 200)).toBeNull()
    expect(calls).toBe(1)
  })

  it('stops on an empty page', async () => {
    const src = pagedSource([])
    expect(await findSellerByStripeAccount('acct_a', src.fetch, 50)).toBeNull()
    expect(src.calls).toEqual([0])
  })

  // Sellers with NO stripe account must never be matched by a blank/absent id —
  // that would hand an unrelated shop's readiness to whoever asked for "".
  it('a blank account id matches nothing, not the accountless sellers', async () => {
    const src = pagedSource([sellerWith('s1'), sellerWith('s2')])
    expect(await findSellerByStripeAccount('', src.fetch, 10)).toBeNull()
  })
})

describe('sellerStripeAccountId', () => {
  it('reads a stored account id', () => {
    expect(sellerStripeAccountId(sellerWith('s1', 'acct_a'))).toBe('acct_a')
  })

  it.each([
    ['no metadata', {}],
    ['no settings', { metadata: {} }],
    ['no stripe', { metadata: { settings: {} } }],
    ['empty account id', { metadata: { settings: { stripe: { account_id: '' } } } }],
    ['non-string account id', { metadata: { settings: { stripe: { account_id: 42 } } } }],
  ])('returns null for %s', (_label, seller) => {
    expect(sellerStripeAccountId(seller as never)).toBeNull()
  })
})
