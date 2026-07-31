import { GET } from '../route'

/**
 * D9's rollback must work precisely when something else is broken.
 *
 * `blockingReasons` already exempts the rollback direction from D5's stock-location
 * requirement — pointing the key back at the marketplace channel restores a
 * known-good graph and must not be blockable by the very condition it is undoing.
 * But that exemption sits DOWNSTREAM of the reads: `survey()` calls
 * `readStockLocations()` unconditionally, so an exception there escaped and 500'd
 * the route before `blockingReasons` was ever consulted. The rollback would have
 * been blocked by exactly the failure it exists to recover from.
 *
 * Caught by the codex cross-family review on PR 130 (round 2). The reads now
 * degrade to `available: false` instead of throwing.
 */

const MARKETPLACE = 'sc_01KSK1J0V81P4EPY9G0JAPX353'
const OPERATING = 'sc_01KYWNQ0C0PFFM0K0V2EMC24AP'
const TOKEN = 'pk_live_storefront_token_value'

function fakeRes() {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    status(code: number) { out.status = code; return res },
    json(body: any) { out.body = body; return res },
  }
  return { res, out }
}

/**
 * A container whose api_key read and marketplace-channel reads work, but whose
 * OPERATING-channel stock-location read throws — the partial outage that made the
 * rollback unreachable.
 */
function scopeWithOperatingReadOutage() {
  return {
    resolve: () => ({
      graph: async (args: any) => {
        if (args.entity === 'api_key') {
          return {
            data: [{
              id: 'apk_01KRVSGHN5KMCJSAMMYHRBD42W',
              title: 'Default Publishable API Key',
              token: TOKEN,
              // Already moved forward — this is the state a rollback starts from.
              sales_channels: [{ id: OPERATING }],
            }],
          }
        }
        const fields: string[] = args.fields ?? []
        const wantsLocations = fields.some((f) => f.startsWith('stock_locations'))
        if (args.entity === 'sales_channel' && args.filters?.id === OPERATING && wantsLocations) {
          // ONLY the location graph fails. The existence read still succeeds, so the
          // two failure modes stay distinguishable and the directional assertion
          // below cannot pass on the wrong blocker.
          throw new Error('link table unavailable')
        }
        if (args.entity === 'sales_channel' && args.filters?.id === OPERATING) {
          return { data: [{ id: OPERATING, name: 'Miyagi Operating MX' }] }
        }
        return { data: [{ id: MARKETPLACE, name: 'Miyagi Markets MX', stock_locations: [{ id: 'sloc_1' }] }] }
      },
    }),
  }
}

describe('publishable-key-channel-move — D9 rollback survives a broken operating-channel read', () => {
  const OLD = process.env
  beforeAll(() => {
    process.env = {
      ...OLD,
      MEDUSA_SALES_CHANNEL_ID: MARKETPLACE,
      MEDUSA_MX_OPERATING_CHANNEL_ID: OPERATING,
      MEDUSA_PUBLISHABLE_KEY: TOKEN,
      MEDUSA_INTERNAL_SECRET: 'test-secret',
    } as any
  })
  afterAll(() => { process.env = OLD })

  const req = (desired: string) => ({
    headers: { 'x-internal-secret': 'test-secret' },
    get: (h: string) => (h.toLowerCase() === 'x-internal-secret' ? 'test-secret' : undefined),
    query: { market: 'mx', desired_channel: desired },
    scope: scopeWithOperatingReadOutage(),
  }) as any

  it('does not 500 — the read degrades instead of throwing', async () => {
    const { res, out } = fakeRes()
    await GET(req('marketplace'), res)
    expect(out.status).not.toBe(500)
    expect(out.body).toBeTruthy()
  })

  it('the ROLLBACK is not blocked by the unreadable operating-channel graph', async () => {
    const { res, out } = fakeRes()
    await GET(req('marketplace'), res)
    const blocked: string[] = out.body?.blocked_by ?? []
    expect(blocked.join(' ')).not.toMatch(/stock-location/i)
    expect(out.body.apply_allowed).toBe(true)
  })

  it('the FORWARD move still IS blocked by it — the exemption is directional', async () => {
    // Guard the guard: if the exemption leaked into the forward direction it would
    // let the key move onto a channel that cannot reserve inventory, failing AFTER
    // payment.
    const { res, out } = fakeRes()
    await GET(req('operating'), res)
    const blocked: string[] = out.body?.blocked_by ?? []
    // Match the D5 refusal's OWN wording, not merely any message mentioning stock
    // locations — the underlying error string contains that phrase too, so a looser
    // regex passed even with the D5 guard disabled. Found by mutation-checking this
    // very spec.
    expect(blocked.join(' ')).toMatch(/D5 cannot be proven|fails reservation AFTER payment/)
    expect(out.body.apply_allowed).toBe(false)
  })
})
