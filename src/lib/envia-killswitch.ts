/**
 * src/lib/envia-killswitch.ts
 *
 * Pure decision seam for the platform Envía kill-switch (`shipping.envia_enabled`,
 * enablement polarity / default OFF — see lib/flags.ts). Kept free of Medusa /
 * Flagsmith imports so it is directly unit-testable (mirrors the frontend
 * lib/checkout-killswitch.ts pattern).
 *
 * The flag is the REAL enforcement: the routes resolve `isEnabled(...)` once, hand
 * the boolean here, and act on the decision. When OFF, the quote seam short-circuits
 * to the arranged-delivery fallback and the label seam rejects → manual carrier.
 */

/**
 * The graceful fallback message the quote route returns (`{ rates: [], message }`)
 * when Envía is unavailable, so checkout steers the buyer to arranged delivery.
 * Single source of truth: the no-coverage branch and the kill-switch share it.
 */
export const ENVIA_ARRANGED_DELIVERY_MESSAGE =
  'Las paqueterías no tienen cobertura para ese destino. Puedes coordinar la entrega directamente con el vendedor.'

/**
 * The 422 message the label/ship route returns when Envía is killed platform-wide,
 * steering the seller to the existing manual-carrier path.
 */
export const ENVIA_LABEL_DISABLED_MESSAGE =
  'El envío automático con Envía no está disponible por ahora. Usa paquetería manual.'

export type EnviaKillSwitch = {
  /** `shipping.envia_enabled` — when false, all Envía carrier calls are blocked. */
  enviaEnabled: boolean
}

export type EnviaGateDecision =
  | { blocked: false }
  | { blocked: true; reason: 'platform_envia_disabled' }

/**
 * Decide whether an Envía carrier call (quote or label) may proceed. Pure: ON →
 * passthrough, OFF → blocked. Never throws.
 */
export function enviaKillGate({ enviaEnabled }: EnviaKillSwitch): EnviaGateDecision {
  return enviaEnabled
    ? { blocked: false }
    : { blocked: true, reason: 'platform_envia_disabled' }
}
