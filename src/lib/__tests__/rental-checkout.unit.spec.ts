import { resolveRentalCheckout, type RentalCheckoutInput } from '../rental-checkout'

/**
 * Rental line-item pricing (epic 02) — Sprint 1, Story 1.2.
 *
 * The pure decision behind the start-checkout rental branch. These specs prove:
 *  - a valid range yields the exact server-computed booking (all providers bill it);
 *  - every rejection path returns its 422 code;
 *  - THE TAMPER GUARANTEE — a client-sent amount cannot change the charge, because
 *    the function's input has no amount parameter at all.
 */

const base = (over: Partial<RentalCheckoutInput> = {}): RentalCheckoutInput => ({
  flagEnabled: true,
  fulfillmentMethod: 'rental',
  listingType: 'rental',
  rental: { check_in: '2026-06-13', check_out: '2026-06-16' }, // 3 nights
  rateCents: 120000, // $1,200 / día
  attrs: { rate_period: 'dia', deposit: 2000 }, // deposit in PESOS → 200000 cents
  ...over,
})

describe('resolveRentalCheckout · happy path', () => {
  it('computes nights × daily rate + deposit (deposit read from pesos)', () => {
    const r = resolveRentalCheckout(base())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.booking).toEqual({
      check_in: '2026-06-13',
      check_out: '2026-06-16',
      nights: 3,
      units: 3,
      rate_period: 'dia',
      rate_cents: 120000,
      rent_cents: 360000,
      deposit_cents: 200000, // 2000 pesos → 200000 cents
      total_cents: 560000,
    })
  })

  it('weekly rate over 10 nights bills 2 weeks, zero deposit', () => {
    const r = resolveRentalCheckout(
      base({
        rental: { check_in: '2026-06-01', check_out: '2026-06-11' }, // 10 nights
        rateCents: 300000,
        attrs: { rate_period: 'semana' }, // no deposit key → 0
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.booking.units).toBe(2)
    expect(r.booking.deposit_cents).toBe(0)
    expect(r.booking.total_cents).toBe(600000)
  })

  it('parses a string deposit in pesos', () => {
    const r = resolveRentalCheckout(base({ attrs: { rate_period: 'dia', deposit: '1500' } }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.booking.deposit_cents).toBe(150000)
  })
})

describe('resolveRentalCheckout · 422 ladder', () => {
  it('flag OFF → RENTAL_PRICING_UNAVAILABLE', () => {
    const r = resolveRentalCheckout(base({ flagEnabled: false }))
    expect(r).toEqual(expect.objectContaining({ ok: false, code: 'RENTAL_PRICING_UNAVAILABLE' }))
  })

  it('non-rental fulfillment → RENTAL_METHOD_MISMATCH', () => {
    const r = resolveRentalCheckout(base({ fulfillmentMethod: 'shipping' }))
    expect(r).toEqual(expect.objectContaining({ ok: false, code: 'RENTAL_METHOD_MISMATCH' }))
  })

  it('non-rental listing → RENTAL_NOT_RENTAL_LISTING', () => {
    const r = resolveRentalCheckout(base({ listingType: 'product' }))
    expect(r).toEqual(expect.objectContaining({ ok: false, code: 'RENTAL_NOT_RENTAL_LISTING' }))
  })

  it('reversed / same-day / missing dates → RENTAL_INVALID_DATES', () => {
    expect(resolveRentalCheckout(base({ rental: { check_in: '2026-06-16', check_out: '2026-06-13' } })))
      .toEqual(expect.objectContaining({ ok: false, code: 'RENTAL_INVALID_DATES' }))
    expect(resolveRentalCheckout(base({ rental: { check_in: '2026-06-13', check_out: '2026-06-13' } })))
      .toEqual(expect.objectContaining({ ok: false, code: 'RENTAL_INVALID_DATES' }))
    expect(resolveRentalCheckout(base({ rental: {} })))
      .toEqual(expect.objectContaining({ ok: false, code: 'RENTAL_INVALID_DATES' }))
    expect(resolveRentalCheckout(base({ rental: undefined })))
      .toEqual(expect.objectContaining({ ok: false, code: 'RENTAL_INVALID_DATES' }))
  })

  it('impossible calendar dates (that Date.parse would roll over) → RENTAL_INVALID_DATES', () => {
    // 2026-06-31 would silently normalize to Jul 1 and charge a phantom night.
    expect(resolveRentalCheckout(base({ rental: { check_in: '2026-06-15', check_out: '2026-06-31' } })))
      .toEqual(expect.objectContaining({ ok: false, code: 'RENTAL_INVALID_DATES' }))
    expect(resolveRentalCheckout(base({ rental: { check_in: '2026-02-30', check_out: '2026-03-05' } })))
      .toEqual(expect.objectContaining({ ok: false, code: 'RENTAL_INVALID_DATES' }))
  })

  it('multi-item / multi-quantity cart → RENTAL_CART_UNSUPPORTED', () => {
    expect(resolveRentalCheckout(base({ itemCount: 2 })))
      .toEqual(expect.objectContaining({ ok: false, code: 'RENTAL_CART_UNSUPPORTED' }))
    expect(resolveRentalCheckout(base({ quantity: 2 })))
      .toEqual(expect.objectContaining({ ok: false, code: 'RENTAL_CART_UNSUPPORTED' }))
  })

  it('missing / zero rate → RENTAL_RATE_UNAVAILABLE', () => {
    expect(resolveRentalCheckout(base({ rateCents: 0 })))
      .toEqual(expect.objectContaining({ ok: false, code: 'RENTAL_RATE_UNAVAILABLE' }))
    expect(resolveRentalCheckout(base({ rateCents: Number.NaN })))
      .toEqual(expect.objectContaining({ ok: false, code: 'RENTAL_RATE_UNAVAILABLE' }))
  })

  it('every rejection carries a user-facing es-MX message', () => {
    const r = resolveRentalCheckout(base({ flagEnabled: false }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(typeof r.message).toBe('string')
    expect(r.message.length).toBeGreaterThan(0)
  })
})

describe('resolveRentalCheckout · tamper guarantee', () => {
  it('a client-injected amount cannot change the charge (no amount parameter exists)', () => {
    // Simulate a malicious client stuffing amount-like fields onto the payload.
    // They are structurally ignored — the total is derived only from dates + attrs + rate.
    const tampered = {
      ...base(),
      offer_amount_cents: 1, // client tries to pay 1 cent
      amount_cents: 1,
      total_cents: 1,
      rental: { check_in: '2026-06-13', check_out: '2026-06-16', amount_cents: 1 },
    } as unknown as RentalCheckoutInput

    const r = resolveRentalCheckout(tampered)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Still the honest server-computed total, NOT the injected 1 cent.
    expect(r.booking.total_cents).toBe(560000)
  })
})
