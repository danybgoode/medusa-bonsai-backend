import {
  DEFAULT_SELLER_STATUS,
  SELLER_STATUSES,
  requireSellerStatus,
  decideStatusTransition,
  isSellerStatus,
  parseSellerStatus,
  sellerAdmits,
  sellerRowAdmits,
  transitionRelinks,
  transitionUnlinks,
} from '../seller-status'

/**
 * The seller lifecycle seam (tenant-lifecycle-admin · D1, D2).
 *
 * The load-bearing assertions here are the REFUSALS, not the happy paths: an
 * unreadable status must not admit, a rejected transition must be decided before
 * anything is written, and `deleted` must not be silently reversible.
 */
describe('parseSellerStatus', () => {
  it('accepts each known status', () => {
    for (const status of SELLER_STATUSES) expect(parseSellerStatus(status)).toBe(status)
  })

  it('treats an ABSENT column as the default — the column is NOT NULL, so absent means unselected', () => {
    expect(parseSellerStatus(null)).toBe(DEFAULT_SELLER_STATUS)
    expect(parseSellerStatus(undefined)).toBe(DEFAULT_SELLER_STATUS)
  })

  it('REFUSES an unrecognised value instead of coercing it to active', () => {
    // "I could not read this" and "this shop is open" are different facts. Collapsing
    // them is how a guard silently stops existing.
    expect(parseSellerStatus('suspended')).toBeNull()
    expect(parseSellerStatus('ACTIVE')).toBeNull()
    expect(parseSellerStatus('')).toBeNull()
    expect(parseSellerStatus(1)).toBeNull()
    expect(parseSellerStatus({})).toBeNull()
  })

  it('isSellerStatus is a sound predicate — no leniency while narrowing', () => {
    expect(isSellerStatus('active')).toBe(true)
    expect(isSellerStatus(' active ')).toBe(false)
    expect(isSellerStatus('Active')).toBe(false)
  })
})

describe('sellerAdmits', () => {
  it('admits only active', () => {
    expect(sellerAdmits('active')).toBe(true)
    expect(sellerAdmits('paused')).toBe(false)
    expect(sellerAdmits('deleted')).toBe(false)
  })

  it('does NOT admit an unreadable status', () => {
    expect(sellerAdmits(null)).toBe(false)
  })

  it('sellerRowAdmits refuses a missing row rather than admitting it', () => {
    expect(sellerRowAdmits({ status: 'active' })).toBe(true)
    expect(sellerRowAdmits({ status: 'paused' })).toBe(false)
    expect(sellerRowAdmits({ status: 'nonsense' })).toBe(false)
    expect(sellerRowAdmits(null)).toBe(false)
    expect(sellerRowAdmits(undefined)).toBe(false)
  })

  it('a row read WITHOUT the status column admits HERE — the lenient reader is for display', () => {
    // `sellerRowAdmits` rides on `parseSellerStatus`, which defaults an absent column
    // so a projection that did not select it cannot black out an unrelated read.
    // The two ENFORCEMENT seams deliberately do NOT use this — see
    // `requireSellerStatus` and its spec below.
    expect(sellerRowAdmits({})).toBe(true)
  })
})

describe('requireSellerStatus — the ENFORCEMENT reader', () => {
  it('accepts each known status, exactly like the lenient reader', () => {
    for (const status of SELLER_STATUSES) expect(requireSellerStatus(status)).toBe(status)
  })

  it('REFUSES an absent value, where parseSellerStatus defaults it', () => {
    // This is the whole difference, and it is the difference between a leniency and a
    // hole. On the checkout seam and the portal write gate, `undefined` can only mean
    // the query stopped selecting the column — the column is NOT NULL with a default.
    expect(parseSellerStatus(undefined)).toBe('active')
    expect(requireSellerStatus(undefined)).toBeNull()
    expect(requireSellerStatus(null)).toBeNull()
  })

  it('REFUSES an unrecognised value, like the lenient reader', () => {
    expect(requireSellerStatus('suspended')).toBeNull()
  })
})

describe('decideStatusTransition', () => {
  it('accepts active → paused and back', () => {
    expect(decideStatusTransition('active', 'paused')).toEqual({
      ok: true,
      transition: { from: 'active', to: 'paused' },
    })
    expect(decideStatusTransition('paused', 'active')).toEqual({
      ok: true,
      transition: { from: 'paused', to: 'active' },
    })
  })

  it('refuses an unknown TARGET, naming the allowed set', () => {
    const decision = decideStatusTransition('active', 'suspended')
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.reason).toBe('unknown_status')
      expect(decision.message).toContain('active, paused, deleted')
    }
  })

  it('refuses an unreadable CURRENT status rather than assuming active', () => {
    const decision = decideStatusTransition('gibberish', 'paused')
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.reason).toBe('unknown_status')
  })

  it('refuses a no-op transition, so an unchanged write is never reported as a change', () => {
    const decision = decideStatusTransition('paused', 'paused')
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.reason).toBe('no_change')
  })

  it('treats deleted as TERMINAL — undeleting is a product decision, not a status PATCH', () => {
    for (const to of ['active', 'paused'] as const) {
      const decision = decideStatusTransition('deleted', to)
      expect(decision.ok).toBe(false)
      if (!decision.ok) expect(decision.reason).toBe('deleted_is_terminal')
    }
  })

  it('decides BEFORE any write — every refusal is a pure value, never a thrown side effect', () => {
    // The owned-shop epic shipped a defect where validation ran after the writes, so a
    // rejected request persisted half of itself and still returned an error. A pure
    // decision function makes that shape impossible rather than merely unlikely.
    expect(() => decideStatusTransition(undefined, undefined)).not.toThrow()
    expect(decideStatusTransition(undefined, undefined).ok).toBe(false)
  })
})

describe('transition effects', () => {
  it('leaving active unlinks; returning to active relinks', () => {
    expect(transitionUnlinks({ from: 'active', to: 'paused' })).toBe(true)
    expect(transitionUnlinks({ from: 'active', to: 'deleted' })).toBe(true)
    expect(transitionUnlinks({ from: 'paused', to: 'deleted' })).toBe(false)

    expect(transitionRelinks({ from: 'paused', to: 'active' })).toBe(true)
    expect(transitionRelinks({ from: 'active', to: 'paused' })).toBe(false)
  })

  it('paused → deleted neither unlinks nor relinks — the products are already out', () => {
    const transition = { from: 'paused', to: 'deleted' } as const
    expect(transitionUnlinks(transition)).toBe(false)
    expect(transitionRelinks(transition)).toBe(false)
  })
})
