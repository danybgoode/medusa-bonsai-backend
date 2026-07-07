import { readRentalBooking, deriveRentalBookingState } from '../rental-booking'
import { normalizeMedusaOrder } from '../../api/store/sellers/me/orders/route'

/**
 * Rental line-item pricing (epic 02) — Sprint 1, Story 1.3.
 *
 * Proves the order read exposes the `rental_booking` block (raw + derived state)
 * for a rental order, and leaves every non-rental order byte-for-byte unchanged.
 */

const BOOKING = {
  check_in: '2026-06-13',
  check_out: '2026-06-16',
  nights: 3,
  units: 3,
  rate_period: 'dia',
  rate_cents: 120000,
  rent_cents: 360000,
  deposit_cents: 200000,
  total_cents: 560000,
}

describe('rental-booking · readRentalBooking', () => {
  it('returns the block when present', () => {
    expect(readRentalBooking({ rental_booking: BOOKING })).toEqual(BOOKING)
  })

  it('returns null when absent / malformed', () => {
    expect(readRentalBooking({})).toBeNull()
    expect(readRentalBooking(null)).toBeNull()
    expect(readRentalBooking(undefined)).toBeNull()
    expect(readRentalBooking({ rental_booking: null })).toBeNull()
    expect(readRentalBooking({ rental_booking: 'nope' })).toBeNull()
    expect(readRentalBooking({ rental_booking: [] })).toBeNull()
  })
})

describe('rental-booking · deriveRentalBookingState', () => {
  it("'reservado' only for a real booking (positive nights + total)", () => {
    expect(deriveRentalBookingState(BOOKING)).toBe('reservado')
  })

  it("'none' for null / zero nights / zero total / malformed", () => {
    expect(deriveRentalBookingState(null)).toBe('none')
    expect(deriveRentalBookingState({ ...BOOKING, nights: 0 })).toBe('none')
    expect(deriveRentalBookingState({ ...BOOKING, total_cents: 0 })).toBe('none')
    expect(deriveRentalBookingState({ nights: 'x', total_cents: 'y' })).toBe('none')
    expect(deriveRentalBookingState({})).toBe('none')
  })
})

describe('normalizeMedusaOrder · rental_booking exposure', () => {
  const baseOrder = (metadata: Record<string, unknown>) => ({
    id: 'order_1',
    items: [{ product_id: 'prod_1', title: 'Cámara en renta', unit_price: 120000, quantity: 1 }],
    metadata,
    total: 560000,
    currency_code: 'mxn',
    created_at: '2026-06-10T00:00:00Z',
    updated_at: '2026-06-10T00:00:00Z',
  })

  it('surfaces rental_booking + rental_booking_state for a rental order', () => {
    const out = normalizeMedusaOrder(baseOrder({ rental_booking: BOOKING }), 'seller_1', 'Tienda')
    expect(out.rental_booking).toEqual(BOOKING)
    expect(out.rental_booking_state).toBe('reservado')
  })

  it('a non-rental order is unchanged: rental_booking null, state none', () => {
    const out = normalizeMedusaOrder(baseOrder({ payment_method: 'stripe' }), 'seller_1', 'Tienda')
    expect(out.rental_booking).toBeNull()
    expect(out.rental_booking_state).toBe('none')
    // Spot-check that unrelated normalization is untouched.
    expect(out.id).toBe('order_1')
    expect(out.amount_cents).toBe(560000)
    expect(out.payment_method).toBe('stripe')
  })
})
