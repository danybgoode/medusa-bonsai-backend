jest.mock('../../../../lib/flags', () => ({
  isEnabled: jest.fn(async () => false),
}))

import { GET as getListing } from '../../listings/[id]/route'
import { GET as getListings } from '../../listings/route'

const MX_MARKETPLACE = 'sc_mx_marketplace'
const US_MARKETPLACE = 'sc_us_marketplace'

function responseCapture() {
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const response = {
    status(code: number) { captured.status = code; return response },
    json(body: any) { captured.body = body; return response },
  }
  return { captured, response: response as any }
}

function detailRequest(market: string, product: any) {
  return {
    params: { id: product.id },
    query: { market },
    scope: {
      resolve(key: string) {
        if (key === 'remoteQuery') {
          return { graph: async () => ({ data: [product] }) }
        }
        return { listSellers: async () => [] }
      },
    },
  } as any
}

describe('public catalog routes — named market states and bidirectional isolation', () => {
  const OLD_ENV = process.env

  beforeAll(() => {
    process.env = {
      ...OLD_ENV,
      MEDUSA_SALES_CHANNEL_ID: MX_MARKETPLACE,
      MEDUSA_US_MARKETPLACE_CHANNEL_ID: US_MARKETPLACE,
    }
  })
  afterAll(() => { process.env = OLD_ENV })
  afterEach(() => { process.env.MEDUSA_US_MARKETPLACE_CHANNEL_ID = US_MARKETPLACE })

  it('the route names an unknown market instead of defaulting to MX', async () => {
    const { captured, response } = responseCapture()
    await getListings({ query: { market: 'fr' } } as any, response)
    expect(captured).toEqual({
      status: 400,
      body: expect.objectContaining({
        unavailable: true,
        market_code: 'fr',
        reason: 'unknown_market',
      }),
    })
  })

  it('the route names an unconfigured active US market instead of returning an empty list', async () => {
    delete process.env.MEDUSA_US_MARKETPLACE_CHANNEL_ID
    const { captured, response } = responseCapture()
    await getListings({ query: { market: 'us' } } as any, response)
    expect(captured).toEqual({
      status: 503,
      body: expect.objectContaining({
        unavailable: true,
        market_code: 'us',
        marketplace_status: 'active',
        reason: 'market_filter_unavailable',
        message: expect.stringMatching(/MEDUSA_US_MARKETPLACE_CHANNEL_ID/),
      }),
    })
  })

  it('a US detail read cannot return an MX-only product', async () => {
    const product = {
      id: 'prod_mx',
      status: 'published',
      metadata: {},
      sales_channels: [{ id: MX_MARKETPLACE }],
    }
    const { captured, response } = responseCapture()
    await getListing(detailRequest('us', product), response)
    expect(captured).toEqual({ status: 404, body: { message: 'Listing not found' } })
  })

  it('a configured US detail route returns a US member and names its market', async () => {
    const product = {
      id: 'prod_us_visible',
      title: 'US listing',
      status: 'published',
      metadata: {},
      sales_channels: [{ id: US_MARKETPLACE }],
    }
    const { captured, response } = responseCapture()
    await getListing(detailRequest('us', product), response)
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual(expect.objectContaining({
      market_code: 'us',
      listing: expect.objectContaining({ id: 'prod_us_visible', currency: 'USD' }),
    }))
  })

  it('an MX detail read cannot return a US-only product', async () => {
    const product = {
      id: 'prod_us',
      status: 'published',
      metadata: {},
      sales_channels: [{ id: US_MARKETPLACE }],
    }
    const { captured, response } = responseCapture()
    await getListing(detailRequest('mx', product), response)
    expect(captured).toEqual({ status: 404, body: { message: 'Listing not found' } })
  })
})
