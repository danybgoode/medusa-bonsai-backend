/**
 * Unit spec — GET /store/home/personalization (marketplace-static-shell S3).
 * Covers: the Clerk-JWT auth gate (401 on missing/invalid), the response shape
 * (data-only, buyer+seller inputs, no es-MX copy), and per-section degradation.
 * Mocked — no DB, no network (jest `*.unit.spec.ts`, like support-seller-resolution).
 */

import { bearerToken, verifyClerkJwt } from '../../../_utils/clerk-verify'
import { buildHomePersonalization, GET } from '../route'

// Mock jose so we never hit Clerk's network JWKS in a unit test.
const mockJwtVerify = jest.fn()
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => ({})),
  jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
}))

// ── A flexible Supabase mock: a chainable builder whose resolved value is decided
//    by a per-test resolver(ctx) from the table + recorded filters. ──
type QueryCtx = {
  table: string
  eqs: Array<[string, unknown]>
  ins: Array<[string, unknown[]]>
}
function makeSupabase(
  resolver: (ctx: QueryCtx) => { data: unknown; error?: unknown },
  throwOnTable?: string,
) {
  return {
    from(table: string) {
      if (throwOnTable && table === throwOnTable) {
        throw new Error(`boom: ${table}`)
      }
      const ctx: QueryCtx = { table, eqs: [], ins: [] }
      const result = () => Promise.resolve(resolver(ctx))
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: (col: string, val: unknown) => {
          ctx.eqs.push([col, val])
          return builder
        },
        in: (col: string, vals: unknown[]) => {
          ctx.ins.push([col, vals])
          return builder
        },
        maybeSingle: result,
        single: result,
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          result().then(res, rej),
      }
      return builder
    },
  } as unknown as Parameters<typeof buildHomePersonalization>[0]['supabase']
}

const sellerService = {
  listSellers: jest.fn(async () => [{ id: 'sel_1' }]),
} as unknown as Parameters<typeof buildHomePersonalization>[0]['sellerService']

const remoteQuery = {
  graph: jest.fn(async () => ({
    data: [{ products: [{ metadata: { views: 12 } }, { metadata: { views: 8 } }] }],
  })),
} as unknown as Parameters<typeof buildHomePersonalization>[0]['remoteQuery']

function mockRes() {
  const res: { statusCode: number; body: unknown; status: jest.Mock; json: jest.Mock } = {
    statusCode: 200,
    body: undefined,
    status: jest.fn(function (this: typeof res, code: number) {
      this.statusCode = code
      return this
    }),
    json: jest.fn(function (this: typeof res, body: unknown) {
      this.body = body
      return this
    }),
  }
  return res
}

beforeEach(() => {
  mockJwtVerify.mockReset()
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_aG9uZXN0LWVlbC0zOS5jbGVyay5hY2NvdW50cy5kZXYk'
})

describe('auth gate', () => {
  it('bearerToken returns null when no Authorization header', () => {
    expect(bearerToken({ headers: {} } as never)).toBeNull()
  })

  it('verifyClerkJwt rejects a missing token without touching jose', async () => {
    expect(await verifyClerkJwt(null)).toBeNull()
    expect(mockJwtVerify).not.toHaveBeenCalled()
  })

  it('verifyClerkJwt rejects an unverifiable token (bad signature)', async () => {
    mockJwtVerify.mockRejectedValue(new Error('signature verification failed'))
    expect(await verifyClerkJwt('forged.jwt.token')).toBeNull()
  })

  it('verifyClerkJwt returns sub for a valid token', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 'user_42', email: 'a@b.com' } })
    expect(await verifyClerkJwt('good.jwt.token')).toEqual({ sub: 'user_42', email: 'a@b.com' })
  })

  it('GET responds 401 when the JWT is missing', async () => {
    const res = mockRes()
    await GET({ headers: {} } as never, res as never)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ message: 'Authentication required' })
  })

  it('GET responds 401 when the JWT is forged', async () => {
    mockJwtVerify.mockRejectedValue(new Error('bad sig'))
    const res = mockRes()
    await GET({ headers: { authorization: 'Bearer forged' } } as never, res as never)
    expect(res.status).toHaveBeenCalledWith(401)
  })
})

describe('buildHomePersonalization — shape', () => {
  const resolver = (ctx: QueryCtx) => {
    if (ctx.table === 'marketplace_shops') {
      return { data: { id: 'shop_1', slug: 'mi-tienda', name: 'Mi Tienda' } }
    }
    if (ctx.table === 'marketplace_favorites') {
      return {
        data: [
          {
            marketplace_listings: {
              medusa_product_id: 'prod_1', title: 'Lámpara', price_cents: 25000,
              currency: 'mxn', condition: 'good', location: 'CDMX',
              images: [{ url: 'http://img/1.jpg' }], status: 'active',
            },
          },
          // dropped: no medusa id
          { marketplace_listings: { medusa_product_id: null, title: 'X', price_cents: 1, currency: 'mxn', condition: null, location: null, images: null, status: 'active' } },
        ],
      }
    }
    if (ctx.table === 'marketplace_offers') {
      const isBuyer = ctx.eqs.some(([c]) => c === 'buyer_clerk_user_id')
      if (isBuyer) {
        return {
          data: [{
            id: 'off_b', offer_amount_cents: 50000, status: 'pending', expires_at: '2099-01-01T00:00:00Z',
            marketplace_listings: { title: 'Bici', currency: 'mxn', marketplace_shops: { name: 'Otra Tienda' } },
          }],
        }
      }
      return {
        data: [{
          id: 'off_s', offer_amount_cents: 30000, status: 'pending', expires_at: '2099-02-01T00:00:00Z',
          marketplace_listings: { title: 'Silla', currency: 'mxn' },
        }],
      }
    }
    if (ctx.table === 'marketplace_conversations') {
      return { data: [{ id: 'conv_b', offer_id: 'off_b' }] }
    }
    return { data: [] }
  }

  it('returns the 4-field data-only shape with buyer + seller inputs', async () => {
    const out = await buildHomePersonalization({
      supabase: makeSupabase(resolver), sellerService, remoteQuery, clerkUserId: 'user_42',
    })

    // recentFavorites: only the linkable active one, currency upper-cased
    expect(out.recentFavorites).toEqual([
      { medusaId: 'prod_1', title: 'Lámpara', priceCents: 25000, currency: 'MXN', condition: 'good', location: 'CDMX', imageUrl: 'http://img/1.jpg' },
    ])

    // offerAlertInputs: a buyer + a seller input, data only (no title/subtitle/href/icon)
    const buyer = out.offerAlertInputs.find((o) => o.perspective === 'buyer')!
    const seller = out.offerAlertInputs.find((o) => o.perspective === 'seller')!
    expect(buyer).toEqual({
      offerId: 'off_b', conversationId: 'conv_b', perspective: 'buyer', status: 'pending',
      expiresAt: '2099-01-01T00:00:00Z', amountCents: 50000, currency: 'MXN',
      listingTitle: 'Bici', shopName: 'Otra Tienda',
    })
    expect(seller).toEqual({
      offerId: 'off_s', conversationId: null, perspective: 'seller', status: 'pending',
      expiresAt: '2099-02-01T00:00:00Z', amountCents: 30000, currency: 'MXN',
      listingTitle: 'Silla', shopName: null,
    })
    // No derived copy fields leak through.
    for (const o of out.offerAlertInputs) {
      expect(o).not.toHaveProperty('title')
      expect(o).not.toHaveProperty('href')
      expect(o).not.toHaveProperty('icon')
    }

    // sellerSnapshot + hasShop
    expect(out.hasShop).toBe(true)
    expect(out.sellerSnapshot).toEqual({ shopName: 'Mi Tienda', visitas: 20, ofertasNuevas: 1 })
  })

  it('hasShop=false and null snapshot when the user has no shop', async () => {
    const noShop = (ctx: QueryCtx) =>
      ctx.table === 'marketplace_shops' ? { data: null } : resolver(ctx)
    const out = await buildHomePersonalization({
      supabase: makeSupabase(noShop), sellerService, remoteQuery, clerkUserId: 'user_42',
    })
    expect(out.hasShop).toBe(false)
    expect(out.sellerSnapshot).toBeNull()
    // buyer offers still returned; seller offers skipped (no shop)
    expect(out.offerAlertInputs.every((o) => o.perspective === 'buyer')).toBe(true)
  })
})

describe('buildHomePersonalization — degrade', () => {
  it('a thrown favorites/offers read degrades to empty, never throws', async () => {
    const out = await buildHomePersonalization({
      supabase: makeSupabase(() => ({ data: null, error: 'db down' }), 'marketplace_favorites'),
      sellerService, remoteQuery, clerkUserId: 'user_42',
    })
    expect(out.recentFavorites).toEqual([])
    expect(Array.isArray(out.offerAlertInputs)).toBe(true)
  })
})
