const writes: Array<{ kind: string; input?: any }> = []

jest.mock('@medusajs/medusa/core-flows', () => ({
  createProductsWorkflow: jest.fn(() => ({
    run: jest.fn(async (input) => {
      writes.push({ kind: 'create-product', input })
      return { result: [{ id: 'prod_us', variants: [{ id: 'variant_us' }] }] }
    }),
  })),
  updateProductsWorkflow: jest.fn(() => ({
    run: jest.fn(async (input) => {
      writes.push({ kind: 'publish-product', input })
      return { result: [{ id: 'prod_us' }] }
    }),
  })),
}))

jest.mock('../../../../lib/flags', () => ({
  isEnabled: jest.fn(async () => false),
}))

jest.mock('../inventory', () => ({
  isStockableListingType: jest.fn(() => true),
  resolveStockLocationId: jest.fn(async (_scope, market) =>
    market === 'us' ? 'sloc_us' : 'sloc_mx'),
  provisionVariantInventory: jest.fn(async (_scope, input) => {
    writes.push({ kind: 'provision-inventory', input })
  }),
}))

jest.mock('../fulfillment', () => ({
  resolveDefaultShippingProfileId: jest.fn(async () => 'sp_default'),
}))

import { createSellerProduct } from '../seller-product-create'

const MX_MARKETPLACE = 'sc_mx_marketplace'
const MX_OPERATING = 'sc_mx_operating'
const US_MARKETPLACE = 'sc_us_marketplace'
const US_OPERATING = 'sc_us_operating'

const seller = {
  id: 'sel_us',
  slug: 'us-shop',
  metadata: { operating_market: 'us' },
}

function fakeScope() {
  const service = {
    listSellers: async () => [seller],
    listProductCategories: async () => [],
    listProductTypes: async () => [],
    create: async (input: any) => { writes.push({ kind: 'link-seller', input }) },
  }
  return { resolve: () => service } as any
}

describe('createSellerProduct — first ordinary active-US workflow capture', () => {
  const OLD_ENV = process.env

  beforeAll(() => {
    process.env = {
      ...OLD_ENV,
      MEDUSA_SALES_CHANNEL_ID: MX_MARKETPLACE,
      MEDUSA_MX_OPERATING_CHANNEL_ID: MX_OPERATING,
      MEDUSA_US_MARKETPLACE_CHANNEL_ID: US_MARKETPLACE,
      MEDUSA_US_OPERATING_CHANNEL_ID: US_OPERATING,
      MEDUSA_US_STOCK_LOCATION_ID: 'sloc_us',
    }
  })
  afterAll(() => { process.env = OLD_ENV })
  beforeEach(() => { writes.length = 0 })

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 2500.5],
  ])('refuses a %s USD price before every write', async (_label, price_cents) => {
    const result = await createSellerProduct(fakeScope(), seller.id, {
      title: 'US listing',
      listing_type: 'product',
      price_cents,
    })
    expect(result).toEqual({
      ok: false,
      status: 422,
      message: expect.stringMatching(/positive integer USD price/),
    })
    expect(writes).toEqual([])
  })

  it('creates one positive USD price row, publishes to both US channels, and leaks no MX id', async () => {
    const result = await createSellerProduct(fakeScope(), seller.id, {
      title: 'Hand-thrown mug',
      description: 'Made in Brooklyn',
      listing_type: 'product',
      price_cents: 2599,
      currency: 'USD',
      quantity: 1,
    })

    expect(result).toEqual({ ok: true, product_id: 'prod_us' })

    const create = writes.find((entry) => entry.kind === 'create-product')?.input
    const productInput = create?.input?.products?.[0]
    expect(productInput).toMatchObject({
      title: 'Hand-thrown mug',
      status: 'draft',
      shipping_profile_id: 'sp_default',
      sales_channels: [{ id: US_OPERATING }, { id: US_MARKETPLACE }],
      metadata: { price_cents: 2599, currency: 'USD' },
      variants: [{
        manage_inventory: true,
        prices: [{ amount: 2599, currency_code: 'usd' }],
      }],
    })
    expect(JSON.stringify(productInput)).not.toContain(MX_MARKETPLACE)
    expect(JSON.stringify(productInput)).not.toContain(MX_OPERATING)

    expect(writes.find((entry) => entry.kind === 'provision-inventory')?.input).toEqual({
      variantId: 'variant_us',
      salesChannelIds: [US_OPERATING, US_MARKETPLACE],
      locationId: 'sloc_us',
      quantity: 1,
    })
    expect(writes.map((entry) => entry.kind)).toEqual([
      'create-product',
      'link-seller',
      'provision-inventory',
      'publish-product',
    ])
  })
})
