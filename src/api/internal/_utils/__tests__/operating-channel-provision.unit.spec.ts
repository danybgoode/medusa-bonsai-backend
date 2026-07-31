import { provisionOperatingChannel } from '../operating-channel-provision'

const MARKETPLACE = 'sc_01KSK1J0V81P4EPY9G0JAPX353'
const OPERATING = 'sc_operating_mx'

/**
 * A fake container. `graph` is driven by a per-entity handler so a test can say
 * "the channel row does not exist" (the ghost case) without a database.
 */
function scopeWith(rows: Record<string, unknown[]>) {
  const calls: Array<{ entity: string; filters: unknown }> = []
  const scope = {
    resolve: () => ({
      graph: async (args: any) => {
        calls.push({ entity: args.entity, filters: args.filters })
        const key = `${args.entity}:${args.filters?.id ?? ''}`
        return { data: rows[key] ?? [] }
      },
    }),
  }
  return { scope, calls }
}

const ENV_BOTH = {
  MEDUSA_SALES_CHANNEL_ID: MARKETPLACE,
  MEDUSA_MX_OPERATING_CHANNEL_ID: OPERATING,
}

describe('provisionOperatingChannel — refusals happen before any write', () => {
  it('refuses when the MARKETPLACE channel is unconfigured — D5 has no source to replicate', async () => {
    const { scope } = scopeWith({})
    const report = await provisionOperatingChannel(scope, {
      market: 'mx', apply: true, env: { MEDUSA_MX_OPERATING_CHANNEL_ID: OPERATING },
    })
    expect(report.blocked_by.join(' ')).toMatch(/Marketplace channel unavailable/)
    expect(report.channel_created).toBe(false)
  })

  it('refuses a GHOST id — env var set but no such row — instead of creating a second channel', async () => {
    // The dangerous alternative: create a fresh channel, leaving the env var
    // pointing at nothing while a real channel quietly accumulates links.
    const { scope } = scopeWith({ [`sales_channel:${OPERATING}`]: [] })
    const report = await provisionOperatingChannel(scope, {
      market: 'mx', apply: true, env: ENV_BOTH,
    })
    expect(report.blocked_by.join(' ')).toMatch(/no such Sales Channel exists/)
    expect(report.channel_created).toBe(false)
    expect(report.channel_id).toBeNull()
  })

  it('refuses `us` — structurally, and at the FIRST gate it trips', async () => {
    // `us` has no marketplace channel in any environment either, so it is refused by
    // the D5-source check before the operating-channel branch is ever reached. The
    // property that matters is that it is refused and creates nothing — asserting the
    // *operating*-channel wording here would have been asserting the wrong gate, and
    // the fix would have been to weaken real code to match a wrong test.
    const { scope } = scopeWith({})
    const report = await provisionOperatingChannel(scope, {
      market: 'us', apply: true, env: ENV_BOTH,
    })
    expect(report.blocked_by.join(' ')).toMatch(/in any environment/i)
    expect(report.channel_created).toBe(false)
    expect(report.would_create).toBe(false)
    expect(report.channel_id).toBeNull()
  })
})

describe('provisionOperatingChannel — dry run is read-only and reports the D5 source', () => {
  it('before the channel exists, reports the marketplace locations as what WOULD be replicated', async () => {
    // The empty-graph trap: reporting `missing: []` here would read as "nothing to
    // do" when in fact everything is still to do.
    const { scope } = scopeWith({
      [`sales_channel:${MARKETPLACE}`]: [{ id: MARKETPLACE, stock_locations: [{ id: 'sloc_1' }, { id: 'sloc_2' }] }],
    })
    const report = await provisionOperatingChannel(scope, {
      market: 'mx', apply: false, env: { MEDUSA_SALES_CHANNEL_ID: MARKETPLACE },
    })
    expect(report.blocked_by).toEqual([])
    expect(report.would_create).toBe(true)
    expect(report.channel_created).toBe(false)
    expect(report.channel_id).toBeNull()
    expect(report.stock_locations.marketplace).toEqual(['sloc_1', 'sloc_2'])
    expect(report.stock_locations.missing).toEqual(['sloc_1', 'sloc_2'])
  })

  it('with the channel already present, diffs the two graphs and links nothing on a dry run', async () => {
    const { scope } = scopeWith({
      [`sales_channel:${MARKETPLACE}`]: [{ id: MARKETPLACE, stock_locations: [{ id: 'sloc_1' }, { id: 'sloc_2' }] }],
      [`sales_channel:${OPERATING}`]: [{ id: OPERATING, name: 'Miyagi Operating MX', stock_locations: [{ id: 'sloc_1' }] }],
    })
    const report = await provisionOperatingChannel(scope, {
      market: 'mx', apply: false, env: ENV_BOTH,
    })
    expect(report.channel_id).toBe(OPERATING)
    expect(report.would_create).toBe(false)
    expect(report.stock_locations.missing).toEqual(['sloc_2'])
    expect(report.stock_locations.linked).toEqual([])
    // Dry run must not move the "after" number — it is the before, untouched.
    expect(report.stock_locations.operating_after).toEqual(['sloc_1'])
  })

  it('reports no action_required when nothing was created', async () => {
    const { scope } = scopeWith({
      [`sales_channel:${MARKETPLACE}`]: [{ id: MARKETPLACE, stock_locations: [] }],
      [`sales_channel:${OPERATING}`]: [{ id: OPERATING, name: 'x', stock_locations: [] }],
    })
    const report = await provisionOperatingChannel(scope, {
      market: 'mx', apply: false, env: ENV_BOTH,
    })
    expect(report.action_required).toBeNull()
  })
})
