import { GET as getDirectory } from '../route'
import { GET as getProfile } from '../[slug]/route'

function capture() {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    status(code: number) { out.status = code; return res },
    json(body: any) { out.body = body; return res },
  }
  return { out, res }
}

function requestFor(seller: Record<string, unknown> | null) {
  return {
    params: { slug: 'example' },
    query: {},
    scope: { resolve: () => ({
      listSellers: async () => seller ? [seller] : [],
    }) },
  } as any
}

describe('public seller visibility after a removal pause', () => {
  const seller = { id: 'sel_one', slug: 'example', name: 'Example', verified: true, status: 'active', metadata: {} }

  it('returns 404 for paused and deleted profiles, while active stays public', async () => {
    for (const status of ['paused', 'deleted', undefined]) {
      const { out, res } = capture()
      await getProfile(requestFor({ ...seller, status }), res)
      expect(out.status).toBe(404)
    }
    const { out, res } = capture()
    await getProfile(requestFor(seller), res)
    expect(out.status).toBe(200)
    expect(out.body.seller.slug).toBe('example')
  })

  it('asks Medusa only for verified active sellers in the directory', async () => {
    let filters: unknown
    const req: any = { query: {}, scope: { resolve: () => ({
      listAndCountSellers: async (input: unknown) => { filters = input; return [[seller], 1] },
    }) } }
    const { out, res } = capture()
    await getDirectory(req, res)
    expect(filters).toEqual({ verified: true, status: 'active' })
    expect(out.body.sellers).toHaveLength(1)
  })
})
