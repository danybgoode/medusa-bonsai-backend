import {
  deriveOrderLifecycleStatus,
  isOrderEligibleForBulkStatus,
  planOrderStatusTransition,
} from '../order-status-transition'

/**
 * ml-orders-native S3 · US-8 — the pure bulk-status eligibility gate. No DB, no
 * scope: proves the manual-payment (SPEI/cash/DiMo) rule the single-order PATCH
 * already enforces (`meta.payment_received !== true` blocks shipped/in_transit)
 * generalizes correctly to the bulk endpoint's "ineligible order reports why"
 * acceptance.
 */

describe('isOrderEligibleForBulkStatus', () => {
  it('blocks shipped for an unconfirmed manual-payment order', () => {
    for (const method of ['manual', 'spei', 'cash', 'dimo']) {
      const result = isOrderEligibleForBulkStatus({ payment_method: method, payment_received: false }, 'shipped')
      expect(result.eligible).toBe(false)
      if (!result.eligible) expect(result.reason).toMatch(/pago/i)
    }
  })

  it('blocks in_transit the same way', () => {
    const result = isOrderEligibleForBulkStatus({ payment_method: 'spei', payment_received: false }, 'in_transit')
    expect(result.eligible).toBe(false)
  })

  it('allows shipped once payment_received is true', () => {
    const result = isOrderEligibleForBulkStatus({ payment_method: 'spei', payment_received: true }, 'shipped')
    expect(result).toEqual({ eligible: true })
  })

  it('never blocks a card/MP order (payment_method not in the manual set)', () => {
    const result = isOrderEligibleForBulkStatus({ payment_method: 'card', payment_received: false }, 'shipped')
    expect(result).toEqual({ eligible: true })
  })

  it('never blocks "processing" or "delivered" regardless of payment state', () => {
    expect(isOrderEligibleForBulkStatus({ payment_method: 'cash', payment_received: false }, 'processing'))
      .toEqual({ eligible: true })
    expect(isOrderEligibleForBulkStatus({ payment_method: 'cash', payment_received: false }, 'delivered'))
      .toEqual({ eligible: true })
  })

  it('treats a missing payment_method as non-manual (eligible)', () => {
    const result = isOrderEligibleForBulkStatus({}, 'shipped')
    expect(result).toEqual({ eligible: true })
  })
})

describe('planOrderStatusTransition', () => {
  const order = (metadata: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    id: 'order_1',
    status: 'pending',
    payment_status: 'captured',
    fulfillment_status: 'not_fulfilled',
    metadata,
    ...extra,
  })

  it('returns a read-only eligible current → proposed ledger', () => {
    expect(planOrderStatusTransition({ order: order(), newStatus: 'processing' })).toEqual({
      current_status: 'paid',
      proposed_status: 'processing',
      eligible: true,
      reason: null,
    })
  })

  it('reports an unconfirmed manual payment without mutating the order', () => {
    const input = order({ payment_method: 'spei', payment_received: false }, { payment_status: 'authorized' })
    const before = structuredClone(input)
    const plan = planOrderStatusTransition({ order: input, newStatus: 'shipped' })
    expect(plan).toMatchObject({ current_status: 'pending_payment', eligible: false })
    expect(plan.reason).toMatch(/pago/i)
    expect(input).toEqual(before)
  })

  it('reports the existing US manual-carrier tracking refusal', () => {
    const plan = planOrderStatusTransition({
      order: order({ fulfillment_method: 'manual_carrier' }),
      newStatus: 'shipped',
    })
    expect(plan.eligible).toBe(false)
    expect(plan.reason).toMatch(/carrier.*tracking/i)
  })

  it('turns a changed live state into a stale skip', () => {
    const plan = planOrderStatusTransition({
      order: order({ fulfillment_state: 'shipped' }),
      newStatus: 'delivered',
      expectedStatus: 'processing',
    })
    expect(plan).toMatchObject({ current_status: 'shipped', eligible: false })
    expect(plan.reason).toMatch(/cambió/i)
  })

  it('refuses a reviewed no-op while preserving legacy callers without a baseline', () => {
    const shipped = order({ fulfillment_state: 'shipped' })
    expect(planOrderStatusTransition({ order: shipped, newStatus: 'shipped', expectedStatus: 'shipped' }).eligible).toBe(false)
    expect(planOrderStatusTransition({ order: shipped, newStatus: 'shipped' }).eligible).toBe(true)
  })
})

describe('deriveOrderLifecycleStatus', () => {
  it('uses the same refund → payment → lifecycle precedence as seller order normalization', () => {
    expect(deriveOrderLifecycleStatus({ status: 'canceled', metadata: {} })).toBe('refunded')
    expect(deriveOrderLifecycleStatus({ payment_status: 'authorized', metadata: { payment_method: 'cash' } })).toBe('pending_payment')
    expect(deriveOrderLifecycleStatus({ payment_status: 'captured', metadata: { fulfillment_state: 'processing' } })).toBe('processing')
    expect(deriveOrderLifecycleStatus({ payment_status: 'captured', fulfillment_status: 'delivered', metadata: {} })).toBe('delivered')
  })
})
