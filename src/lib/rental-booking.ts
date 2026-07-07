/**
 * src/lib/rental-booking.ts
 *
 * Rental line-item pricing (epic 02 · checkout-and-payments) — Sprint 1, Story 1.3.
 *
 * The read side of the `rental_booking` metadata block that start-checkout (S1.2)
 * stamps onto cart → order. `normalizeMedusaOrder` calls these to surface the block
 * (raw, for rendering the breakdown) plus a derived scalar state — mirroring the
 * `pickup_appointment` / `pickup_appointment_state` discipline so the same shape
 * reaches both order pages, both emails, the in-chat ledger, and UCP/MCP agents.
 *
 * Pure / main()-less — unit-tested in `src/lib/__tests__/rental-booking.unit.spec.ts`.
 */

/** The block as it lives on order metadata — read defensively (every field unknown). */
export interface RentalBookingLike {
  check_in?: unknown
  check_out?: unknown
  nights?: unknown
  units?: unknown
  rate_period?: unknown
  rate_cents?: unknown
  rent_cents?: unknown
  deposit_cents?: unknown
  total_cents?: unknown
}

/** Presence-based state: a rental order has a booking, everything else does not. */
export type RentalBookingState = 'none' | 'reservado'

/** Pull `metadata.rental_booking` off an order, or null when absent/malformed. */
export function readRentalBooking(
  metadata: Record<string, unknown> | null | undefined,
): RentalBookingLike | null {
  const block = metadata?.rental_booking
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null
  return block as RentalBookingLike
}

/**
 * Derive the scalar state both sides + agents read. 'reservado' only when the block
 * carries a real booking (positive nights AND a positive total); anything else — no
 * block, a non-rental order, a malformed record — is 'none' (degrades gracefully).
 */
export function deriveRentalBookingState(
  block: RentalBookingLike | null | undefined,
): RentalBookingState {
  if (!block) return 'none'
  const nights = Number(block.nights)
  const total = Number(block.total_cents)
  if (Number.isFinite(nights) && nights > 0 && Number.isFinite(total) && total > 0) {
    return 'reservado'
  }
  return 'none'
}
