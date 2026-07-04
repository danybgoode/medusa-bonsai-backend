import { isOrderEligibleForBulkStatus } from '../order-status-transition'

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
