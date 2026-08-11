import { isMxSeller } from '../ml-market-guard'

const scope = (seller: unknown) => ({
  resolve: () => ({ listSellers: async () => seller ? [seller] : [] }),
}) as any

describe('ML inventory market guard', () => {
  it('admits only a server-resolved MX seller', async () => {
    await expect(isMxSeller(scope({ metadata: { operating_market: 'mx' } }), 'sel_mx')).resolves.toBe(true)
    await expect(isMxSeller(scope({ metadata: { operating_market: 'us' } }), 'sel_us')).resolves.toBe(false)
  })

  it('fails closed on missing or invalid seller state', async () => {
    await expect(isMxSeller(scope(null), 'sel_missing')).resolves.toBe(false)
    await expect(isMxSeller(scope({ metadata: { operating_market: 'es-MX' } }), 'sel_bad')).resolves.toBe(false)
  })
})
