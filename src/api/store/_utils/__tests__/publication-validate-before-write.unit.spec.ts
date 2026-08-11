const trace: string[] = []

jest.mock('@medusajs/medusa/core-flows', () => ({
  updateProductsWorkflow: jest.fn(() => ({
    run: jest.fn(async () => { trace.push('product-write'); return { result: [{ id: 'prod_1' }] } }),
  })),
  linkProductsToSalesChannelWorkflow: jest.fn(() => ({
    run: jest.fn(async () => { trace.push('channel-link'); return {} }),
  })),
  createProductsWorkflow: jest.fn(),
}))

jest.mock('../../../../lib/flags', () => ({
  isEnabled: jest.fn(async () => false), // flag OFF ⇒ publish_to_market: null is refused
}))

import { updateSellerProduct } from '../seller-product-update'

/**
 * S3.2 — VALIDATE BEFORE WRITE, asserted as an ORDERING.
 *
 * The publication plan originally sat at the BOTTOM of `updateSellerProduct`, after
 * the title/images/price/quantity workflows had already run. So
 * `{ title: "Nuevo", publish_to_market: null }` with the flag OFF persisted the
 * title and THEN returned 423 — a partial write reported to the caller as a
 * failure, which is the worst of both: the client believes nothing happened and
 * retries. This function is not transactional, so the refusal has to come first.
 *
 * Asserting "it returned 423" would NOT protect this property — the old, broken
 * code returned 423 too. What distinguishes them is whether a write happened
 * BEFORE the refusal, so the spec records a trace and asserts on it. (The lock-spec
 * lesson in LEARNINGS: assert the ordering, not that the wrapper was called.)
 *
 * Caught by the codex cross-family review on PR 131.
 */

const SELLER = { id: 'sel_1', slug: 'mi-tienda', metadata: { operating_market: 'mx' } }

function fakeScope() {
  return {
    resolve: (key: string) => {
      if (key === 'remoteQuery') return async () => []
      return {
        listSellers: async () => [SELLER],
        retrieveProduct: async () => ({ id: 'prod_1', variants: [] }),
        listProducts: async () => [{ id: 'prod_1', variants: [] }],
        updateProducts: async () => { trace.push('product-write'); return [{ id: 'prod_1' }] },
        listProductVariants: async () => [],
        updateProductVariants: async () => { trace.push('product-write'); return [] },
      }
    },
  } as any
}

describe('updateSellerProduct — a refused publication writes NOTHING first', () => {
  const OLD = process.env
  beforeEach(() => { trace.length = 0 })
  beforeAll(() => {
    process.env = {
      ...OLD,
      MEDUSA_SALES_CHANNEL_ID: 'sc_01KSK1J0V81P4EPY9G0JAPX353',
      MEDUSA_MX_OPERATING_CHANNEL_ID: 'sc_01KYWNQ0C0PFFM0K0V2EMC24AP',
      MEDUSA_STOCK_LOCATION_ID: 'sloc_mx',
    } as any
  })
  afterAll(() => { process.env = OLD })

  it('refuses with 423 and performs NO write when the flag is off', async () => {
    const result = await updateSellerProduct(
      fakeScope(),
      'prod_1',
      { title: 'Nuevo', publish_to_market: null } as any,
      SELLER,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe(423)
    // THE POINT: the old code also returned 423 — after writing the title.
    expect(trace).toEqual([])
  })

  it('a normal update with no publication field still writes', async () => {
    // Guard the guard: if the hoisted block accidentally returned early for every
    // request, the assertion above would pass while the route did nothing at all.
    const result = await updateSellerProduct(
      fakeScope(),
      'prod_1',
      { title: 'Nuevo' } as any,
      SELLER,
    )
    expect(result.ok).toBe(true)
    expect(trace.length).toBeGreaterThan(0)
  })

  it('refuses an option-dimension write before variant I/O when the US location is unavailable', async () => {
    const result = await updateSellerProduct(
      fakeScope(),
      'prod_1',
      {
        option_dimensions: [{ title: 'Size', values: ['S'] }],
        variant_prices: { 'Size:S': 1000 },
      } as any,
      { id: 'sel_us', slug: 'us-shop', metadata: { operating_market: 'us' } },
    )
    expect(result).toMatchObject({ ok: false, status: 503 })
    expect(trace).toEqual([])
  })

  it('refuses tracked inventory-mode admission before product I/O when the market location is unavailable', async () => {
    const result = await updateSellerProduct(
      fakeScope(),
      'prod_1',
      { inventory_mode: 'tracked', variant_id: 'variant_1' } as any,
      { id: 'sel_us', slug: 'us-shop', metadata: { operating_market: 'us' } },
    )
    expect(result).toMatchObject({ ok: false, status: 503 })
    expect(trace).toEqual([])
  })
})
