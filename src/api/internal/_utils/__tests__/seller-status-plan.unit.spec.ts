import { PAUSED_LINKS_KEY, type ChannelLink } from '../../../../lib/seller-channel-ledger'
import { planSellerStatusChange, type StatusPlanInput } from '../seller-status-plan'

/**
 * The seller status plan (tenant-lifecycle-admin · S1.2).
 *
 * The first spec below is the one that matters. The first cut of this feature had a
 * correct, well-tested ledger and a route that fed it a fabricated cartesian product
 * of every product × every market channel — so unpausing would have CREATED a
 * marketplace link an owned-shop-only product never had, publishing a private
 * catalog, with every unit test green. Testing the pure core was not enough; the
 * decision had to swallow the input-shaping too. These specs pin that.
 */
const MARKETPLACE = 'sc_marketplace'
const OPERATING = 'sc_operating'
const CHANNELS = [MARKETPLACE, OPERATING]

const link = (product_id: string, sales_channel_id: string): ChannelLink => ({ product_id, sales_channel_id })

function input(overrides: Partial<StatusPlanInput> = {}): StatusPlanInput {
  return {
    currentStatus: 'active',
    targetStatus: 'paused',
    metadata: {},
    actualLinks: [],
    existingProductIds: new Set<string>(),
    marketChannelIds: CHANNELS,
    ...overrides,
  }
}

describe('pausing records only REAL memberships', () => {
  it('never records a pair the seller does not actually have', () => {
    // `owned_only` is deliberately absent from the marketplace channel. If the plan
    // records it, unpause will create it and publish a private catalog.
    const plan = planSellerStatusChange(input({
      actualLinks: [
        link('public_prod', MARKETPLACE),
        link('public_prod', OPERATING),
        link('owned_only', OPERATING),
      ],
      existingProductIds: new Set(['public_prod', 'owned_only']),
    }))
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.unlink).toEqual([
      link('owned_only', OPERATING),
      link('public_prod', MARKETPLACE),
      link('public_prod', OPERATING),
    ])
    expect(plan.unlink).not.toContainEqual(link('owned_only', MARKETPLACE))
    expect(plan.ledgerAfter).toEqual(plan.unlink)
  })

  it('ignores memberships in channels this deployment does not manage', () => {
    // A product may sit in a channel that is not one of our markets. Removing it
    // would be a change nobody asked for, and recording it would restore it later.
    const plan = planSellerStatusChange(input({
      actualLinks: [link('p', MARKETPLACE), link('p', 'sc_someone_elses')],
      existingProductIds: new Set(['p']),
    }))
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.unlink).toEqual([link('p', MARKETPLACE)])
  })

  it('a seller with no links pauses cleanly with an empty ledger', () => {
    const plan = planSellerStatusChange(input())
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.unlink).toEqual([])
    expect(plan.ledgerAfter).toEqual([])
    expect(plan.complete).toBe(true)
  })
})

describe('unpausing replays the ledger against what is true NOW', () => {
  const ledgerMeta = (links: ChannelLink[]) => ({ [PAUSED_LINKS_KEY]: links })

  it('restores exactly what was recorded', () => {
    const plan = planSellerStatusChange(input({
      currentStatus: 'paused',
      targetStatus: 'active',
      metadata: ledgerMeta([link('p', MARKETPLACE)]),
      existingProductIds: new Set(['p']),
    }))
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.relink).toEqual([link('p', MARKETPLACE)])
    expect(plan.ledgerAfter).toBeNull()
    expect(plan.complete).toBe(true)
  })

  it('does NOT recreate a link that reappeared during the pause', () => {
    // Passing the real current links is what makes this possible. The first cut
    // passed `[]` here, so `alreadyLinked` could never populate and `link.create`
    // would have attempted a duplicate link row.
    const plan = planSellerStatusChange(input({
      currentStatus: 'paused',
      targetStatus: 'active',
      metadata: ledgerMeta([link('p', MARKETPLACE)]),
      actualLinks: [link('p', MARKETPLACE)],
      existingProductIds: new Set(['p']),
    }))
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.relink).toEqual([])
    expect(plan.alreadyLinked).toEqual([link('p', MARKETPLACE)])
    expect(plan.complete).toBe(true)
  })

  it('an INCOMPLETE restore keeps the remainder in the ledger instead of clearing it', () => {
    // Clearing a ledger whose links were never recreated destroys the only record of
    // what the shop is missing. The remainder survives so a retry can act on it.
    const plan = planSellerStatusChange(input({
      currentStatus: 'paused',
      targetStatus: 'active',
      metadata: ledgerMeta([link('p', MARKETPLACE), link('gone', OPERATING)]),
      existingProductIds: new Set(['p']),
    }))
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.relink).toEqual([link('p', MARKETPLACE)])
    expect(plan.missingProducts).toEqual([link('gone', OPERATING)])
    expect(plan.complete).toBe(false)
    expect(plan.ledgerAfter).toEqual([link('gone', OPERATING)])
  })
})

describe('channel configuration is required only when it is used', () => {
  it('refuses 503 when a PAUSE has no channels to unlink from', () => {
    const plan = planSellerStatusChange(input({ marketChannelIds: [] }))
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.httpStatus).toBe(503)
    expect(plan.reason).toBe('no_market_channels')
  })

  it('does NOT require channels for paused → active, which is driven by the ledger', () => {
    const plan = planSellerStatusChange(input({
      currentStatus: 'paused',
      targetStatus: 'active',
      metadata: { [PAUSED_LINKS_KEY]: [link('p', MARKETPLACE)] },
      existingProductIds: new Set(['p']),
      marketChannelIds: [],
    }))
    expect(plan.ok).toBe(true)
  })

  it('does NOT require channels for paused → deleted, which is already dark', () => {
    const plan = planSellerStatusChange(input({
      currentStatus: 'paused',
      targetStatus: 'deleted',
      marketChannelIds: [],
    }))
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.unlink).toEqual([])
    expect(plan.relink).toEqual([])
  })

  it('paused → deleted PRESERVES the ledger — the record outlives the transition', () => {
    const plan = planSellerStatusChange(input({
      currentStatus: 'paused',
      targetStatus: 'deleted',
      metadata: { [PAUSED_LINKS_KEY]: [link('p', MARKETPLACE)] },
      marketChannelIds: [],
    }))
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.ledgerAfter).toEqual([link('p', MARKETPLACE)])
  })
})

describe('refusals come back as plans, never as thrown exceptions', () => {
  it('an unknown target is 400 and names the allowed set', () => {
    const plan = planSellerStatusChange(input({ targetStatus: 'suspended' }))
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.httpStatus).toBe(400)
    expect(plan.message).toContain('active, paused, deleted')
  })

  it('a no-op is 409, so an unchanged write is never reported as a change', () => {
    const plan = planSellerStatusChange(input({ currentStatus: 'paused', targetStatus: 'paused' }))
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.httpStatus).toBe(409)
  })

  it('an unreadable current status is 400, not an assumed active', () => {
    const plan = planSellerStatusChange(input({ currentStatus: 'gibberish' }))
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toBe('unknown_status')
  })

  it('deleted is terminal', () => {
    const plan = planSellerStatusChange(input({ currentStatus: 'deleted', targetStatus: 'active' }))
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toBe('deleted_is_terminal')
  })
})
