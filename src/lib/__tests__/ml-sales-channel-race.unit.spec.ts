import {
  __resetMlSalesChannelCacheForTests,
  __resolveMlSalesChannelIdForTests as resolveMlSalesChannelId,
} from '../ml-order-materialize'

/**
 * The find-or-create race on the ML sales channel.
 *
 * Found by a delegated Codex review (2026-07-26) that contradicted the architect's assessment: the six
 * `require-atomic-updates` sites were judged "very likely benign — a lost race costs a duplicate
 * fetch". True for the read-only lookups; FALSE for this one, because it CREATES. Two concurrent ML
 * order materializations could both find no channel and both create one, leaving duplicate persistent
 * sales channels.
 *
 * The resolver is module-private, so this drives it through the exported test seam plus an injected
 * scope — asserting the invariant that matters: however many callers race, `createSalesChannels` is
 * called AT MOST ONCE.
 */

type Call = { list: number; create: number }

function makeScope(counts: Call, existing: { id: string } | null) {
  const svc = {
    listSalesChannels: async () => {
      counts.list++
      // Simulate real async latency so concurrent callers genuinely interleave — without an await
      // here the race cannot be reproduced and the test would pass against the buggy version too.
      await new Promise((r) => setTimeout(r, 5))
      return existing ? [existing] : []
    },
    createSalesChannels: async () => {
      counts.create++
      await new Promise((r) => setTimeout(r, 5))
      return { id: 'sc_created' }
    },
  }
  return { resolve: () => svc } as any
}

describe('resolveMlSalesChannelId — concurrent find-or-create', () => {
  beforeEach(() => __resetMlSalesChannelCacheForTests())

  it('creates the channel AT MOST ONCE when many callers race', async () => {
    const counts: Call = { list: 0, create: 0 }
    const scope = makeScope(counts, null)
    const r = resolveMlSalesChannelId
    const results = await Promise.all([r(scope), r(scope), r(scope), r(scope)])

    expect(counts.create).toBe(1)
    expect(new Set(results).size).toBe(1)
  })

  it('returns the existing channel without creating one', async () => {
    const counts: Call = { list: 0, create: 0 }
    const scope = makeScope(counts, { id: 'sc_existing' })
    const r = resolveMlSalesChannelId
    const results = await Promise.all([r(scope), r(scope), r(scope)])

    expect(counts.create).toBe(0)
    expect(results).toEqual(['sc_existing', 'sc_existing', 'sc_existing'])
  })

  it('clears the slot on failure so a transient error does not poison later calls', async () => {
    const counts: Call = { list: 0, create: 0 }
    let fail = true
    const scope = {
      resolve: () => ({
        listSalesChannels: async () => {
          counts.list++
          if (fail) throw new Error('transient')
          return [{ id: 'sc_recovered' }]
        },
        createSalesChannels: async () => {
          counts.create++
          return { id: 'sc_created' }
        },
      }),
    } as any
    await expect(resolveMlSalesChannelId(scope)).rejects.toThrow('transient')
    fail = false
    await expect(resolveMlSalesChannelId(scope)).resolves.toBe('sc_recovered')
  })
})
