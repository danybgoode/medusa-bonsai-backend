import {
  PAUSED_LINKS_KEY,
  buildPausedLinks,
  planRestore,
  readPausedLinks,
  restoreIsComplete,
  type ChannelLink,
} from '../seller-channel-ledger'

/**
 * The pause/unpause channel-link ledger (tenant-lifecycle-admin · D4).
 *
 * The assertion that matters most is the owned-shop one: unpausing must not publish a
 * private catalog to the marketplace. Everything else here exists to make that
 * property hold under a world that moved while the shop was paused.
 */
const link = (product_id: string, sales_channel_id: string): ChannelLink => ({ product_id, sales_channel_id })

const MARKETPLACE = 'sc_marketplace'
const OPERATING = 'sc_operating'

describe('readPausedLinks', () => {
  it('reads a well-formed ledger', () => {
    const metadata = { [PAUSED_LINKS_KEY]: [link('prod_1', MARKETPLACE)] }
    expect(readPausedLinks(metadata)).toEqual([link('prod_1', MARKETPLACE)])
  })

  it('an ABSENT ledger is an empty one — a shop can be paused owning nothing', () => {
    expect(readPausedLinks(null)).toEqual([])
    expect(readPausedLinks({})).toEqual([])
    expect(readPausedLinks({ [PAUSED_LINKS_KEY]: 'not-an-array' })).toEqual([])
  })

  it('DROPS a malformed entry rather than adopting it', () => {
    // Replaying a pair with a missing id would either throw mid-restore or link
    // something arbitrary. Dropping it keeps the restore honest; the count difference
    // is what surfaces the gap.
    const metadata = {
      [PAUSED_LINKS_KEY]: [
        link('prod_1', MARKETPLACE),
        { product_id: 'prod_2' },
        { sales_channel_id: MARKETPLACE },
        { product_id: '', sales_channel_id: MARKETPLACE },
        { product_id: 'prod_3', sales_channel_id: 42 },
        null,
        'nonsense',
      ],
    }
    expect(readPausedLinks(metadata)).toEqual([link('prod_1', MARKETPLACE)])
  })

  it('deduplicates, so a double pause cannot double-restore', () => {
    const metadata = { [PAUSED_LINKS_KEY]: [link('prod_1', MARKETPLACE), link('prod_1', MARKETPLACE)] }
    expect(readPausedLinks(metadata)).toHaveLength(1)
  })
})

describe('buildPausedLinks', () => {
  it('records exactly what is being removed, deduplicated and stably ordered', () => {
    const built = buildPausedLinks([
      link('prod_2', OPERATING),
      link('prod_1', MARKETPLACE),
      link('prod_2', OPERATING),
    ])
    expect(built).toEqual([link('prod_1', MARKETPLACE), link('prod_2', OPERATING)])
  })

  it('two pauses of the same shop produce identical records', () => {
    const a = buildPausedLinks([link('b', OPERATING), link('a', MARKETPLACE)])
    const b = buildPausedLinks([link('a', MARKETPLACE), link('b', OPERATING)])
    expect(a).toEqual(b)
  })

  it('skips malformed pairs instead of recording an unreplayable one', () => {
    const built = buildPausedLinks([
      link('prod_1', MARKETPLACE),
      { product_id: '', sales_channel_id: OPERATING },
      { product_id: 'prod_2', sales_channel_id: '' },
    ] as ChannelLink[])
    expect(built).toEqual([link('prod_1', MARKETPLACE)])
  })
})

describe('planRestore', () => {
  const exists = (...ids: string[]) => new Set(ids)

  it('restores exactly what the ledger recorded', () => {
    const plan = planRestore([link('prod_1', MARKETPLACE)], [], exists('prod_1'))
    expect(plan.restore).toEqual([link('prod_1', MARKETPLACE)])
    expect(plan.alreadyLinked).toEqual([])
    expect(plan.missingProducts).toEqual([])
  })

  it('NEVER relinks an owned-shop product to the marketplace — the whole point of the ledger', () => {
    // The seller owns two products. Only the marketplace link was removed at pause;
    // the owned-shop product was already absent from the marketplace by design. A
    // naive "relink everything this seller owns" would publish it.
    const ledger = [link('public_prod', MARKETPLACE), link('public_prod', OPERATING), link('owned_only', OPERATING)]
    const plan = planRestore(ledger, [], exists('public_prod', 'owned_only'))
    expect(plan.restore).toEqual(ledger)
    // The pair that was never recorded is never restored.
    expect(plan.restore).not.toContainEqual(link('owned_only', MARKETPLACE))
  })

  it('reports an ALREADY-linked pair instead of creating a duplicate link row', () => {
    const plan = planRestore([link('prod_1', MARKETPLACE)], [link('prod_1', MARKETPLACE)], exists('prod_1'))
    expect(plan.restore).toEqual([])
    expect(plan.alreadyLinked).toEqual([link('prod_1', MARKETPLACE)])
  })

  it('reports a product that no longer exists rather than restoring fewer links silently', () => {
    const plan = planRestore([link('gone', MARKETPLACE)], [], exists())
    expect(plan.restore).toEqual([])
    expect(plan.missingProducts).toEqual([link('gone', MARKETPLACE)])
  })

  it('every recorded pair lands in exactly ONE bucket — the caller can assert completeness', () => {
    const ledger = [link('a', MARKETPLACE), link('b', MARKETPLACE), link('gone', OPERATING)]
    const plan = planRestore(ledger, [link('b', MARKETPLACE)], exists('a', 'b'))
    expect(plan.restore.length + plan.alreadyLinked.length + plan.missingProducts.length).toBe(ledger.length)
  })

  it('an empty ledger plans nothing and is complete', () => {
    const plan = planRestore([], [], exists())
    expect(plan.restore).toEqual([])
    expect(restoreIsComplete(plan)).toBe(true)
  })
})

describe('restoreIsComplete', () => {
  it('already-linked counts as complete — the pair IS linked, we simply did not do it', () => {
    const plan = planRestore([link('prod_1', MARKETPLACE)], [link('prod_1', MARKETPLACE)], new Set(['prod_1']))
    expect(restoreIsComplete(plan)).toBe(true)
  })

  it('a missing product makes the restore INCOMPLETE — the shop came back with less', () => {
    const plan = planRestore([link('gone', MARKETPLACE)], [], new Set<string>())
    expect(restoreIsComplete(plan)).toBe(false)
  })
})
