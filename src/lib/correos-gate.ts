/**
 * src/lib/correos-gate.ts
 *
 * Pure decision seam for Correos de México (`shipping.correos_enabled`, enablement
 * polarity / default OFF — see lib/flags.ts), mirroring the shape of
 * envia-killswitch.ts. Unlike Envía, Correos has no comp-grant and no funding gate —
 * it's a two-input AND: the platform flag must be ON, and the seller must have opted in
 * (`seller.metadata.settings.shipping.correos_enabled === true`). Weight eligibility is
 * a separate concern, handled by `quoteCorreos` returning `null` over the table's max.
 */

export type CorreosGateInput = {
  /** `shipping.correos_enabled` (platform flag). */
  correosEnabled: boolean
  /** `seller.metadata.settings.shipping.correos_enabled` (per-shop opt-in). */
  sellerOptIn: boolean
}

export type CorreosGateDecision =
  | { blocked: false }
  | { blocked: true; reason: 'platform_correos_disabled' | 'seller_not_opted_in' }

/**
 * Decide whether a Correos quote may be offered. Pure, never throws. Both the platform
 * flag AND the seller opt-in must be true — neither one alone is enough.
 */
export function correosGate({ correosEnabled, sellerOptIn }: CorreosGateInput): CorreosGateDecision {
  if (!correosEnabled) return { blocked: true, reason: 'platform_correos_disabled' }
  if (!sellerOptIn) return { blocked: true, reason: 'seller_not_opted_in' }
  return { blocked: false }
}
