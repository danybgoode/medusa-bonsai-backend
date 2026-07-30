import type { MedusaIdResolution } from '../../../../lib/market-medusa'
import {
  marketBackfillBlockingReasons,
  revalidateLinkOwners,
  stampSellerMarketIfAbsent,
  type MarketBackfillPreconditions,
} from '../market-backfill'
import { describeScan } from '../scan-window'

const CHANNEL_ID = 'sc_market_mx'

function state(
  overrides: Partial<MarketBackfillPreconditions> = {},
): MarketBackfillPreconditions {
  return {
    channel: {
      status: 'resolved',
      market: 'mx',
      kind: 'marketplace_channel',
      id: CHANNEL_ID,
    },
    channel_exists: true,
    seller_plan: { abort: false },
    seller_scan: describeScan(18, 2000, 'sellers'),
    product_scan: describeScan(77, 5000, 'published products'),
    ownership_scan_failures: [],
    link_plan: { skipped_unowned: [] },
    ...overrides,
  }
}

describe('marketBackfillBlockingReasons — validate every precondition before apply', () => {
  it('allows only a complete, classifiable population with a real configured channel', () => {
    expect(marketBackfillBlockingReasons(state())).toEqual([])
  })

  it('blocks a stale channel id before any seller can be stamped', () => {
    const reasons = marketBackfillBlockingReasons(state({ channel_exists: false }))
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(new RegExp(`${CHANNEL_ID}.*does not exist`))
    expect(reasons[0]).toMatch(/half-applied backfill/)
  })

  it.each([
    {
      name: 'unconfigured channel',
      channel: {
        status: 'unconfigured',
        market: 'mx',
        kind: 'marketplace_channel',
        env_var: 'MEDUSA_SALES_CHANNEL_ID',
        reason: 'channel env missing',
      } satisfies MedusaIdResolution,
      expected: /channel env missing/,
    },
    {
      name: 'market with no channel',
      channel: {
        status: 'no_resource',
        market: 'us',
        kind: 'marketplace_channel',
        reason: 'US channel does not exist',
      } satisfies MedusaIdResolution,
      expected: /no marketplace channel/,
    },
  ])('blocks a $name', ({ channel, expected }) => {
    expect(marketBackfillBlockingReasons(state({ channel }))).toEqual([
      expect.stringMatching(expected),
    ])
  })

  it('blocks unknown seller markets, ownership read failures, and unowned products', () => {
    const reasons = marketBackfillBlockingReasons(state({
      seller_plan: { abort: true },
      ownership_scan_failures: [{ seller_id: 'sel_broken', reason: 'database unavailable' }],
      link_plan: { skipped_unowned: ['prod_orphan'] },
    }))

    expect(reasons).toEqual(expect.arrayContaining([
      expect.stringMatching(/unrecognised operating_market/),
      expect.stringMatching(/sel_broken.*unavailable ownership read/),
      expect.stringMatching(/1 published product.*no resolvable owner/),
    ]))
  })

  it('returns every blocker together instead of making the operator retry one at a time', () => {
    const reasons = marketBackfillBlockingReasons(state({
      channel_exists: false,
      seller_plan: { abort: true },
      seller_scan: describeScan(2000, 2000, 'sellers'),
      product_scan: describeScan(5000, 5000, 'published products'),
    }))

    expect(reasons).toHaveLength(4)
    expect(reasons.join('\n')).toMatch(/does not exist/)
    expect(reasons.join('\n')).toMatch(/operating_market/)
    expect(reasons.join('\n')).toMatch(/2000-row window/)
    expect(reasons.join('\n')).toMatch(/5000-row window/)
  })
})

describe('describeScan — a filled cap is never called complete', () => {
  it('marks a short page complete', () => {
    expect(describeScan(1999, 2000, 'sellers')).toEqual({
      scanned: 1999,
      cap: 2000,
      complete: true,
    })
  })

  it.each([
    ['exactly full', 2000],
    ['defensively overfull', 2001],
  ])('marks an %s page incomplete', (_label, scanned) => {
    const scan = describeScan(scanned, 2000, 'sellers')
    expect(scan.complete).toBe(false)
    expect(scan.reason).toMatch(/not authoritative/)
    expect(scan.reason).toMatch(/no write may be applied/)
  })
})

describe('stampSellerMarketIfAbsent — one atomic metadata-key update', () => {
  it.each([
    [{ rowCount: 1 }, 'updated'],
    [{ rowCount: 0 }, 'skipped'],
  ] as const)('maps the conditional UPDATE result %#', async (result, expected) => {
    const raw = jest.fn(async (_sql: string, _bindings: readonly unknown[]) => result)
    await expect(stampSellerMarketIfAbsent({ raw }, 'sel_1', 'mx')).resolves.toBe(expected)
    const [sql, bindings] = raw.mock.calls[0]
    expect(sql).toMatch(/jsonb_set/)
    expect(sql).toMatch(/metadata->>'operating_market'/)
    expect(sql).toMatch(/RETURNING id/)
    expect(bindings).toEqual(['mx', 'sel_1'])
  })
})

describe('revalidateLinkOwners — concurrent market stamp interleaving', () => {
  const ownerMap = new Map([
    ['prod_1', 'sel_1'],
    ['prod_2', 'sel_2'],
  ])

  it('allows the link batch only when every live owner is still explicitly in the planned market', async () => {
    await expect(revalidateLinkOwners({
      product_ids: ['prod_1', 'prod_2'],
      owner_seller_by_product: ownerMap,
      planned_market: 'mx',
      read_seller: async (id) => ({ id, metadata: { operating_market: 'mx' } }),
    })).resolves.toEqual([])
  })

  it('blocks ALL linking when a concurrent US stamp wins after the MX survey', async () => {
    // Interleaving: survey saw sel_2 with no key (legacy MX), then another writer
    // stamps US, so stampSellerMarketIfAbsent returns "skipped". The live re-read
    // must reject the stale MX product plan before the link workflow runs.
    const failures = await revalidateLinkOwners({
      product_ids: ['prod_1', 'prod_2'],
      owner_seller_by_product: ownerMap,
      planned_market: 'mx',
      read_seller: async (id) => ({
        id,
        metadata: { operating_market: id === 'sel_2' ? 'us' : 'mx' },
      }),
    })
    expect(failures).toEqual([{
      seller_id: 'sel_2',
      reason: expect.stringMatching(/live operating_market is us.*planned mx/),
    }])
  })

  it('treats a still-absent or unavailable owner as a blocker, never legacy-default MX', async () => {
    const absent = await revalidateLinkOwners({
      product_ids: ['prod_1'],
      owner_seller_by_product: ownerMap,
      planned_market: 'mx',
      read_seller: async () => ({ id: 'sel_1', metadata: {} }),
    })
    expect(absent[0].reason).toMatch(/legacy_default/)

    const unavailable = await revalidateLinkOwners({
      product_ids: ['prod_1'],
      owner_seller_by_product: ownerMap,
      planned_market: 'mx',
      read_seller: async () => null,
    })
    expect(unavailable[0].reason).toMatch(/unavailable/)
  })
})
