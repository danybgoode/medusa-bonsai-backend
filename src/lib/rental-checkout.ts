/**
 * src/lib/rental-checkout.ts
 *
 * Rental line-item pricing (epic 02 · checkout-and-payments) — Sprint 1, Story 1.2.
 *
 * The pure decision at the heart of the rental checkout branch: given the buyer's
 * dates + the product's own attributes, either produce the server-computed booking
 * (nights × rate + deposit) or reject with a 422 code. `start-checkout/route.ts`
 * calls this, uses `booking.total_cents` as the charge override, and stamps
 * `booking` onto cart → order metadata.
 *
 * THE HARD RULE (tamper guarantee): this function's input has NO amount field. The
 * charged total can ONLY be derived from the dates + the product's `attrs` + the
 * listing's own rate (its variant price, passed as `rateCents`). A client-sent
 * amount is therefore *structurally* incapable of influencing the result — there is
 * no parameter to carry one. The route reads only `body.rental.check_in/check_out`.
 *
 * Pure / main()-less — unit-tested in `src/lib/__tests__/rental-checkout.unit.spec.ts`.
 */

import {
  toRatePeriod,
  nightsBetween,
  isValidYmd,
  readDepositCents,
  computeRentalTotal,
  type RatePeriod,
} from './rental-pricing'

/** The structured block that rides cart → order metadata as `rental_booking`. */
export interface RentalBooking {
  check_in: string
  check_out: string
  nights: number
  units: number
  rate_period: RatePeriod
  rate_cents: number
  rent_cents: number
  deposit_cents: number
  total_cents: number
}

export interface RentalCheckoutInput {
  /** `checkout.rental_pricing_enabled` — OFF ⇒ today's coordination flow (422). */
  flagEnabled: boolean
  /** `body.fulfillment_method` — must be 'rental'. */
  fulfillmentMethod: string | null | undefined
  /** The product's resolved listing type (`type.value ?? metadata.listing_type`). */
  listingType: string | null | undefined
  /** ONLY the dates — deliberately no amount field (tamper guarantee). */
  rental: { check_in?: unknown; check_out?: unknown } | null | undefined
  /** The rate per period, in cents — the listing's own variant/unit price. */
  rateCents: number
  /** The product's `metadata.attrs` (rate_period + deposit-in-pesos live here). */
  attrs: Record<string, unknown> | null | undefined
  /** Number of distinct line items in the cart (rentals are single-item). Default 1. */
  itemCount?: number
  /** Quantity on the rental line item (a rental books ONE unit for a date range). Default 1. */
  quantity?: number
}

export type RentalCheckoutResult =
  | { ok: true; booking: RentalBooking }
  | { ok: false; code: string; message: string }

/** es-MX fallback — every non-date rejection routes the buyer back to coordinating. */
const COORDINATE = 'La reservación en línea no está disponible. Coordina las fechas y el pago con el vendedor.'

/**
 * Resolve a rental checkout to a server-computed booking, or a 422 code. The
 * validation ladder is ordered cheapest → most specific; every path returns a
 * user-facing es-MX `message`.
 */
export function resolveRentalCheckout(input: RentalCheckoutInput): RentalCheckoutResult {
  if (!input.flagEnabled) {
    return { ok: false, code: 'RENTAL_PRICING_UNAVAILABLE', message: COORDINATE }
  }
  if (input.fulfillmentMethod !== 'rental') {
    return { ok: false, code: 'RENTAL_METHOD_MISMATCH', message: COORDINATE }
  }
  if (input.listingType !== 'rental') {
    return { ok: false, code: 'RENTAL_NOT_RENTAL_LISTING', message: COORDINATE }
  }
  // Rentals book ONE unit for a date range. The computed total replaces the whole
  // item subtotal, so a multi-item or multi-quantity cart would mischarge (drop the
  // other items, or bill one unit for many) — reject it rather than charge wrong.
  if ((input.itemCount ?? 1) !== 1 || (input.quantity ?? 1) !== 1) {
    return { ok: false, code: 'RENTAL_CART_UNSUPPORTED', message: COORDINATE }
  }

  const checkIn = input.rental?.check_in
  const checkOut = input.rental?.check_out
  // Strict calendar validity FIRST — `nightsBetween` would otherwise silently accept a
  // rolled-over impossible date (2026-06-31 → Jul 1) and charge a phantom night.
  if (!isValidYmd(checkIn) || !isValidYmd(checkOut)) {
    return {
      ok: false,
      code: 'RENTAL_INVALID_DATES',
      message: 'Selecciona una fecha de entrada y una de salida válidas para reservar.',
    }
  }
  const nights = nightsBetween(checkIn, checkOut)
  if (nights <= 0) {
    return {
      ok: false,
      code: 'RENTAL_INVALID_DATES',
      message: 'Selecciona una fecha de entrada y una de salida válidas para reservar.',
    }
  }

  const rateCents = Math.round(Number(input.rateCents) || 0)
  if (rateCents <= 0) {
    return { ok: false, code: 'RENTAL_RATE_UNAVAILABLE', message: COORDINATE }
  }

  const period = toRatePeriod((input.attrs ?? {}).rate_period)
  const depositCents = readDepositCents(input.attrs)
  const price = computeRentalTotal({ rateCents, depositCents, nights, period })

  // Defensive: nights > 0 and rateCents > 0 already guarantee a positive total.
  if (price.totalCents <= 0) {
    return { ok: false, code: 'RENTAL_RATE_UNAVAILABLE', message: COORDINATE }
  }

  return {
    ok: true,
    booking: {
      check_in: checkIn as string,
      check_out: checkOut as string,
      nights: price.nights,
      units: price.units,
      rate_period: price.period,
      rate_cents: rateCents,
      rent_cents: price.rentCents,
      deposit_cents: price.depositCents,
      total_cents: price.totalCents,
    },
  }
}
