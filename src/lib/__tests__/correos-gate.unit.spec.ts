import { correosGate } from '../correos-gate'

/**
 * Correos de México gate · shipping-provider-expansion Sprint 3, Story 3.1.
 * Two-input AND — platform flag ON AND seller opted in. No comp-grant (unlike Envía).
 */

describe('correosGate · shipping.correos_enabled', () => {
  it('blocks when the platform flag is OFF, regardless of seller opt-in', () => {
    expect(correosGate({ correosEnabled: false, sellerOptIn: true })).toEqual({
      blocked: true,
      reason: 'platform_correos_disabled',
    })
    expect(correosGate({ correosEnabled: false, sellerOptIn: false })).toEqual({
      blocked: true,
      reason: 'platform_correos_disabled',
    })
  })

  it('blocks when the flag is ON but the seller has not opted in', () => {
    expect(correosGate({ correosEnabled: true, sellerOptIn: false })).toEqual({
      blocked: true,
      reason: 'seller_not_opted_in',
    })
  })

  it('passes through only when the flag is ON and the seller opted in', () => {
    expect(correosGate({ correosEnabled: true, sellerOptIn: true })).toEqual({ blocked: false })
  })
})
