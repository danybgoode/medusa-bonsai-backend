import {
  enviaKillGate,
  ENVIA_ARRANGED_DELIVERY_MESSAGE,
  ENVIA_LABEL_DISABLED_MESSAGE,
} from '../envia-killswitch'

/**
 * Envía Flagsmith kill-switch · Sprint 1 (backend enforcement).
 * The `shipping.envia_enabled` flag (enablement polarity / default OFF), applied
 * at the single decision seam shared by the quote route and the ship/label route.
 * Pure function — no Flagsmith, no DB. The flag *value* is resolved by
 * src/lib/flags.ts (fail-open); this proves the gate decision.
 */

describe('enviaKillGate · shipping.envia_enabled', () => {
  it('passes through when the flag is ON', () => {
    expect(enviaKillGate({ enviaEnabled: true })).toEqual({ blocked: false })
  })

  it('blocks when the flag is OFF (the fail-open default)', () => {
    expect(enviaKillGate({ enviaEnabled: false })).toEqual({
      blocked: true,
      reason: 'platform_envia_disabled',
    })
  })

  it('exposes es-MX fallback copy for the quote and label seams', () => {
    expect(ENVIA_ARRANGED_DELIVERY_MESSAGE).toMatch(/coordinar la entrega directamente/)
    expect(ENVIA_LABEL_DISABLED_MESSAGE).toMatch(/paquetería manual/)
  })
})
