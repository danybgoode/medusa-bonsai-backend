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

// The resolver resolves TWO modules now: SALES_CHANNEL and LOCKING. A scope mock that returns one
// service for every resolve() would hand the resolver a sales-channel service where it expects a lock.
// `execute` runs the critical section inline, which is the correct single-process model — the lock's
// job is cross-INSTANCE mutual exclusion, and these specs assert the in-process invariants.
const lockingStub = { execute: async (_key: string, fn: () => Promise<unknown>) => fn() }
function scopeWith(svc: any) {
  return {
    resolve: (mod: any) => (String(mod).toLowerCase().includes('lock') ? lockingStub : svc),
  } as any
}

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
  return scopeWith(svc)
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
    const scope = scopeWith({
        listSalesChannels: async () => {
          counts.list++
          if (fail) throw new Error('transient')
          return [{ id: 'sc_recovered' }]
        },
        createSalesChannels: async () => {
          counts.create++
          return { id: 'sc_created' }
        },
      })
    await expect(resolveMlSalesChannelId(scope)).rejects.toThrow('transient')
    fail = false
    await expect(resolveMlSalesChannelId(scope)).resolves.toBe('sc_recovered')
  })
})

/**
 * The cross-review finding on the first version of this fix — and why it does NOT reproduce.
 *
 * Codex reported (blocking): "multiple callers awaiting rejected P1 each execute
 * `inFlightMlSalesChannel = null`; a late clear can wipe a newer retry promise, reintroducing
 * concurrent createSalesChannels."
 *
 * Verified and REJECTED, with the reasoning pinned here so nobody re-litigates it: a non-creating
 * caller never reaches the try/catch at all. It hits the early return
 * (`if (inFlightMlSalesChannel) return inFlightMlSalesChannel`) and gets the shared promise directly.
 * Only the caller that CREATED the promise runs the clear, exactly once — measured: 3 concurrent
 * callers, 1 clear.
 *
 * The compare-and-clear guard was kept anyway as defence in depth: it costs nothing and becomes
 * load-bearing the moment someone refactors that early return away. This test pins the invariant that
 * makes the whole thing safe — so it fails if that early return is ever removed.
 */
describe('resolveMlSalesChannelId — concurrent callers share ONE attempt', () => {
  beforeEach(() => __resetMlSalesChannelCacheForTests())

  it('runs the underlying lookup once for many concurrent callers, and clears once on failure', async () => {
    let lookups = 0
    const scope = scopeWith({
        listSalesChannels: async () => {
          lookups++
          await new Promise((r) => setTimeout(r, 5))
          throw new Error('transient')
        },
        createSalesChannels: async () => ({ id: 'sc_created' }),
      })

    const settled = await Promise.all([
      resolveMlSalesChannelId(scope).catch(() => 'failed'),
      resolveMlSalesChannelId(scope).catch(() => 'failed'),
      resolveMlSalesChannelId(scope).catch(() => 'failed'),
    ])

    // One shared attempt — the early return is what makes the multi-waiter clobber unreachable.
    expect(lookups).toBe(1)
    expect(settled).toEqual(['failed', 'failed', 'failed'])

    // And the slot really was retracted, so the next caller retries rather than inheriting a
    // permanently rejected promise.
    let second = 0
    const ok = scopeWith({
      listSalesChannels: async () => {
        second++
        return [{ id: 'sc_existing' }]
      },
      createSalesChannels: async () => ({ id: 'sc_created' }),
    })
    await expect(resolveMlSalesChannelId(ok)).resolves.toBe('sc_existing')
    expect(second).toBe(1)
  })
})

/**
 * The memoization itself — added after a fresh-reviewer pass showed the other specs were
 * under-constrained.
 *
 * A `finally`-clear variant (single-flight, but no cross-call memo) passed all four earlier specs
 * while destroying the cache's stated purpose: "re-resolving on every sale is wasted work". The
 * concurrency assertions cannot see that, because they only ever make ONE round of calls. This pins
 * the sequential case, which is the one a plausible future refactor would break.
 */
describe('resolveMlSalesChannelId — memoizes across SEQUENTIAL calls', () => {
  beforeEach(() => __resetMlSalesChannelCacheForTests())

  it('resolves once and reuses it for later, non-concurrent callers', async () => {
    let lookups = 0
    const scope = scopeWith({
        listSalesChannels: async () => {
          lookups++
          return [{ id: 'sc_existing' }]
        },
        createSalesChannels: async () => ({ id: 'sc_created' }),
      })

    // Sequential, fully awaited — no concurrency for a single-flight guard to absorb.
    await expect(resolveMlSalesChannelId(scope)).resolves.toBe('sc_existing')
    await expect(resolveMlSalesChannelId(scope)).resolves.toBe('sc_existing')
    await expect(resolveMlSalesChannelId(scope)).resolves.toBe('sc_existing')

    expect(lookups).toBe(1)
  })
})

/**
 * The DISTRIBUTED lock — and the honest limit of what a unit test can say about it.
 *
 * `medusa-web` runs maxScale=4, so the in-process single-flight above closes only the intra-instance
 * half; four instances could still each find-nothing and each create. `Modules.LOCKING` closes the
 * rest. But a single-process test **cannot observe cross-instance mutual exclusion** — every spec
 * above passes identically with the lock stubbed out to a pass-through (verified by mutation).
 *
 * So this asserts the part that IS observable: the critical section really is wrapped, under a stable
 * key. That fails the moment someone removes or renames the lock, which is the regression worth
 * catching. The cross-instance behaviour itself is covered by the lock module, not by us.
 */
describe('resolveMlSalesChannelId — the find-or-create runs inside a distributed lock', () => {
  beforeEach(() => __resetMlSalesChannelCacheForTests())

  it('wraps the find-or-create in locking.execute under a stable key', async () => {
    const keys: string[] = []
    let ranInside = false
    const svc = {
      listSalesChannels: async () => {
        // If this runs outside the lock, `ranInside` is never set by the wrapper below.
        return [{ id: 'sc_existing' }]
      },
      createSalesChannels: async () => ({ id: 'sc_created' }),
    }
    const scope = {
      resolve: (mod: any) =>
        String(mod).toLowerCase().includes('lock')
          ? {
              execute: async (key: string, fn: () => Promise<string>) => {
                keys.push(key)
                ranInside = true
                return fn()
              },
            }
          : svc,
    } as any

    await expect(resolveMlSalesChannelId(scope)).resolves.toBe('sc_existing')

    expect(ranInside).toBe(true)
    expect(keys).toHaveLength(1)
    // Stable and specific: a key that varied per call would serialize nothing.
    expect(keys[0]).toBe('ml-sales-channel:Mercado Libre')
  })
})
