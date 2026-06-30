// Set the encryption key before importing the module under test (getKey reads
// process.env at call time, but set it up front for clarity).
process.env.ML_TOKEN_ENCRYPTION_KEY = 'unit-test-encryption-key-do-not-use-in-prod'

import {
  encryptToken,
  decryptToken,
  shouldRefresh,
  deriveConnectionHealth,
  sanitizeConnection,
  isDuplicateLink,
  REFRESH_SKEW_MS,
} from '../_utils'

/**
 * Mercado Libre module · Sprint 1 pure helpers (the deterministic backend gate).
 * No DB, no network. Proves: token round-trip + tamper resistance, the
 * refresh-skew decision, health derivation, that sanitisation strips every token
 * field, and the linkage duplicate guard.
 */

describe('encryptToken / decryptToken (AES-256-GCM)', () => {
  it('round-trips a token', () => {
    const plain = 'APP_USR-1234567890-secret-access-token'
    const enc = encryptToken(plain)
    expect(enc).not.toContain(plain)
    expect(decryptToken(enc)).toBe(plain)
  })

  it('produces a different ciphertext each time (random IV)', () => {
    expect(encryptToken('same')).not.toBe(encryptToken('same'))
  })

  it('returns "" on tampered or garbage ciphertext (auth tag fails)', () => {
    const enc = encryptToken('token')
    const tampered = Buffer.from(enc, 'base64')
    tampered[tampered.length - 1] ^= 0xff
    expect(decryptToken(tampered.toString('base64'))).toBe('')
    expect(decryptToken('not-base64-at-all!!')).toBe('')
    expect(decryptToken('')).toBe('')
  })
})

describe('shouldRefresh', () => {
  const now = 1_000_000_000_000

  it('is false when the token is comfortably valid', () => {
    expect(shouldRefresh(now + REFRESH_SKEW_MS + 60_000, now)).toBe(false)
  })

  it('is true within the 5-minute skew window', () => {
    expect(shouldRefresh(now + REFRESH_SKEW_MS - 1, now)).toBe(true)
  })

  it('is true when already expired', () => {
    expect(shouldRefresh(now - 1, now)).toBe(true)
  })

  it('is true (fail-safe) for an invalid date', () => {
    expect(shouldRefresh('not-a-date', now)).toBe(true)
    expect(shouldRefresh(null, now)).toBe(true)
  })
})

describe('deriveConnectionHealth', () => {
  const now = 1_000_000_000_000

  it('disconnected when no connection / disconnected status / no expiry', () => {
    expect(deriveConnectionHealth(null, now).state).toBe('disconnected')
    expect(deriveConnectionHealth({ status: 'disconnected', expires_at: now + 1e9 }, now).state).toBe('disconnected')
    expect(deriveConnectionHealth({ status: 'connected', expires_at: null }, now).state).toBe('disconnected')
  })

  it('expired when past expiry', () => {
    expect(deriveConnectionHealth({ status: 'connected', expires_at: now - 1 }, now).state).toBe('expired')
  })

  it('stale within the skew window', () => {
    expect(deriveConnectionHealth({ status: 'connected', expires_at: now + 60_000 }, now).state).toBe('stale')
  })

  it('connected when comfortably valid, with es-MX label', () => {
    const h = deriveConnectionHealth({ status: 'connected', expires_at: now + 1e9 }, now)
    expect(h.state).toBe('connected')
    expect(h.label_es).toBe('Conectado')
  })
})

describe('sanitizeConnection', () => {
  it('strips every token field', () => {
    const row = {
      id: 'mlc_1',
      seller_id: 'sel_1',
      ml_user_id: '99',
      ml_nickname: 'TESTSHOP',
      country_code: 'MX',
      status: 'connected',
      expires_at: new Date(1_700_000_000_000),
      last_refreshed_at: new Date(1_699_000_000_000),
      access_token_enc: 'SECRET-ENC',
      refresh_token_enc: 'SECRET-ENC',
    }
    const out = sanitizeConnection(row)!
    const keys = Object.keys(out)
    expect(keys.some((k) => k.includes('token'))).toBe(false)
    expect(JSON.stringify(out)).not.toContain('SECRET-ENC')
    expect(out.ml_nickname).toBe('TESTSHOP')
    expect(out.expires_at).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it('returns null for nullish input', () => {
    expect(sanitizeConnection(null)).toBeNull()
    expect(sanitizeConnection(undefined)).toBeNull()
  })
})

describe('isDuplicateLink (1:1 conflict guard)', () => {
  // `existing` = links already matching the candidate's product OR ml_item
  // (the service queries both directions and passes the union).
  const existing = [{ product_id: 'prod_1', ml_item_id: 'MLM1' }]

  it('rejects an exact pair (already linked)', () => {
    expect(isDuplicateLink(existing, { product_id: 'prod_1', ml_item_id: 'MLM1' })).toBe(true)
  })

  it('rejects re-linking a product that is already linked to a different ML item', () => {
    expect(isDuplicateLink(existing, { product_id: 'prod_1', ml_item_id: 'MLM2' })).toBe(true)
  })

  it('rejects linking a different product to an already-linked ML item', () => {
    expect(isDuplicateLink(existing, { product_id: 'prod_2', ml_item_id: 'MLM1' })).toBe(true)
  })

  it('allows a brand-new product ↔ brand-new ML item pair', () => {
    expect(isDuplicateLink([], { product_id: 'prod_9', ml_item_id: 'MLM9' })).toBe(false)
  })
})
