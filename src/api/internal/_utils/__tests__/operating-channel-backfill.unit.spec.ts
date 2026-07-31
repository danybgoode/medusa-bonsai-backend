import type { MedusaIdResolution } from '../../../../lib/market-medusa'
import {
  operatingChannelBackfillBlockingReasons,
  splitByPublished,
  type OperatingChannelBackfillPreconditions,
} from '../operating-channel-backfill'
import { describeScan } from '../scan-window'

const CHANNEL_ID = 'sc_operating_mx'

function state(
  overrides: Partial<OperatingChannelBackfillPreconditions> = {},
): OperatingChannelBackfillPreconditions {
  return {
    channel: {
      status: 'resolved',
      market: 'mx',
      kind: 'operating_channel',
      id: CHANNEL_ID,
    },
    channel_exists: true,
    seller_scan: describeScan(26, 2000, 'sellers'),
    product_scan: describeScan(90, 5000, 'products (all statuses)'),
    ownership_scan_failures: [],
    unclassifiable_sellers: [],
    link_plan: { skipped_unowned: [] },
    ...overrides,
  }
}

describe('operatingChannelBackfillBlockingReasons — validate every precondition before apply', () => {
  it('allows only a complete, classifiable population with a real configured channel', () => {
    expect(operatingChannelBackfillBlockingReasons(state())).toEqual([])
  })

  it('blocks a stale channel id before any product can be linked', () => {
    const reasons = operatingChannelBackfillBlockingReasons(state({ channel_exists: false }))
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
        kind: 'operating_channel',
        env_var: 'MEDUSA_MX_OPERATING_CHANNEL_ID',
        reason: 'operating channel env missing',
      } satisfies MedusaIdResolution,
      expected: /operating channel env missing/,
    },
    {
      name: 'market with no operating channel',
      channel: {
        status: 'no_resource',
        market: 'us',
        kind: 'operating_channel',
        reason: 'US has no operating channel',
      } satisfies MedusaIdResolution,
      expected: /no operating channel/,
    },
  ])('blocks a $name', ({ channel, expected }) => {
    expect(operatingChannelBackfillBlockingReasons(state({ channel }))).toEqual([
      expect.stringMatching(expected),
    ])
  })

  it('blocks unclassifiable sellers, ownership read failures, and unowned products', () => {
    const reasons = operatingChannelBackfillBlockingReasons(state({
      unclassifiable_sellers: [{ seller_id: 'sel_bad', raw: 'es-MX' }],
      ownership_scan_failures: [{ seller_id: 'sel_broken', reason: 'database unavailable' }],
      link_plan: { skipped_unowned: ['prod_orphan'] },
    }))

    expect(reasons).toEqual(expect.arrayContaining([
      expect.stringMatching(/unrecognised operating_market.*sel_bad/),
      expect.stringMatching(/sel_broken.*unavailable ownership read/),
      expect.stringMatching(/1 product\(s\) have no resolvable owner/),
    ]))
  })

  it('a capped (incomplete) scan blocks even when everything else is clean — D6 must ' +
    'see the WHOLE catalog, not a page of it', () => {
    const reasons = operatingChannelBackfillBlockingReasons(state({
      product_scan: describeScan(5000, 5000, 'products (all statuses)'),
    }))
    expect(reasons).toEqual([expect.stringMatching(/5000-row window/)])
  })

  it('returns every blocker together instead of making the operator retry one at a time', () => {
    const reasons = operatingChannelBackfillBlockingReasons(state({
      channel_exists: false,
      unclassifiable_sellers: [{ seller_id: 'sel_bad', raw: 'xx' }],
      seller_scan: describeScan(2000, 2000, 'sellers'),
      product_scan: describeScan(5000, 5000, 'products (all statuses)'),
    }))

    expect(reasons).toHaveLength(4)
    expect(reasons.join('\n')).toMatch(/does not exist/)
    expect(reasons.join('\n')).toMatch(/unrecognised operating_market/)
    expect(reasons.join('\n')).toMatch(/2000-row window/)
    expect(reasons.join('\n')).toMatch(/5000-row window/)
  })
})

describe('splitByPublished — D6: every status is scanned, and the report shows the split', () => {
  it('buckets published separately from every other status', () => {
    const split = splitByPublished([
      { id: 'p1', status: 'published' },
      { id: 'p2', status: 'draft' },
      { id: 'p3', status: 'proposed' },
      { id: 'p4', status: 'rejected' },
      { id: 'p5', status: 'published' },
    ])
    expect(split.published.map((p) => p.id)).toEqual(['p1', 'p5'])
    expect(split.draft.map((p) => p.id)).toEqual(['p2', 'p3', 'p4'])
  })

  it('a null/missing status is treated as draft, never dropped', () => {
    const split = splitByPublished([{ id: 'p1', status: null }, { id: 'p2' }])
    expect(split.published).toEqual([])
    expect(split.draft.map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('every scanned product lands in exactly one bucket', () => {
    const products = [
      { id: 'p1', status: 'published' },
      { id: 'p2', status: 'draft' },
    ]
    const split = splitByPublished(products)
    expect(split.published.length + split.draft.length).toBe(products.length)
  })
})
