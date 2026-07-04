import { deriveMlOrdersEntitlement, readMlSyncGrant, type MlSyncGrant } from '../ml-orders-entitlement'

/**
 * ml-orders-native S2 · US-6 — pure entitlement decision + grant parsing. No DB,
 * no network. Mirrors the frontend's own `ml-sync-monetization.spec.ts` matrix
 * (same precedence, same SKU) — this is the deliberate backend-native port
 * (`deriveMlOrdersEntitlement`), not a shared import (no cross-app package in
 * this architecture; see `flags-cache.ts`'s own "keep two copies in lockstep").
 */

function grantOf(type: MlSyncGrant['type'], overrides: Partial<MlSyncGrant> = {}): MlSyncGrant {
  return { type, granted_at: new Date().toISOString(), ...overrides } as MlSyncGrant
}

describe('readMlSyncGrant — defensive parse, same rule as the frontend reader', () => {
  it('parses a well-formed grant', () => {
    expect(readMlSyncGrant({ ml_sync_grant: { type: 'comp', granted_at: '2026-01-01T00:00:00Z' } })).toEqual({
      type: 'comp',
      granted_at: '2026-01-01T00:00:00Z',
    })
  })
  it('rejects a missing/malformed grant (never accidentally entitles)', () => {
    expect(readMlSyncGrant(null)).toBeNull()
    expect(readMlSyncGrant({})).toBeNull()
    expect(readMlSyncGrant({ ml_sync_grant: { type: 'bogus', granted_at: 'x' } })).toBeNull()
    expect(readMlSyncGrant({ ml_sync_grant: { type: 'comp' } })).toBeNull() // missing granted_at
  })
  it('a one_time grant MUST carry expires_at — a half-written one never entitles forever', () => {
    expect(readMlSyncGrant({ ml_sync_grant: { type: 'one_time', granted_at: '2026-01-01T00:00:00Z' } })).toBeNull()
  })
  it('SKU isolation: a differently-keyed grant is never read as ml_sync', () => {
    expect(readMlSyncGrant({ subdomain_grant: { type: 'comp', granted_at: '2026-01-01T00:00:00Z' } })).toBeNull()
  })
})

describe('deriveMlOrdersEntitlement — precedence: flag_off → grandfather → comp → one_time → subscription → none', () => {
  it('fail-safe: paywall OFF ⇒ entitled regardless of grant/subscription', () => {
    expect(deriveMlOrdersEntitlement({ paywallEnabled: false, grant: null, hasActiveSubscription: false })).toEqual({
      entitled: true,
      reason: 'flag_off',
    })
  })

  it('grandfather and comp grants entitle outright under the paywall', () => {
    expect(deriveMlOrdersEntitlement({ paywallEnabled: true, grant: grantOf('grandfather') }).reason).toBe(
      'grandfathered',
    )
    expect(deriveMlOrdersEntitlement({ paywallEnabled: true, grant: grantOf('comp') }).reason).toBe('comp')
  })

  it('a live one-time grant entitles; an expired one falls through', () => {
    const now = new Date('2026-07-01T00:00:00Z')
    const live = grantOf('one_time', { expires_at: '2026-08-01T00:00:00Z' })
    const expired = grantOf('one_time', { expires_at: '2026-06-01T00:00:00Z' })
    expect(deriveMlOrdersEntitlement({ paywallEnabled: true, grant: live, now }).entitled).toBe(true)
    expect(deriveMlOrdersEntitlement({ paywallEnabled: true, grant: expired, now, hasActiveSubscription: false }).entitled).toBe(
      false,
    )
  })

  it('an active subscription entitles when there is no grant', () => {
    expect(
      deriveMlOrdersEntitlement({ paywallEnabled: true, grant: null, hasActiveSubscription: true }),
    ).toEqual({ entitled: true, reason: 'subscription' })
  })

  it('a grant outranks the subscription lookup (grant wins)', () => {
    expect(
      deriveMlOrdersEntitlement({ paywallEnabled: true, grant: grantOf('comp'), hasActiveSubscription: false }).reason,
    ).toBe('comp')
  })

  it('paywall on + no grant + no subscription ⇒ NOT entitled (materialization skipped, stock sync unaffected)', () => {
    expect(
      deriveMlOrdersEntitlement({ paywallEnabled: true, grant: null, hasActiveSubscription: false }),
    ).toEqual({ entitled: false, reason: 'none' })
  })
})
