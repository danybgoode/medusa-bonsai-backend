process.env.ML_TOKEN_ENCRYPTION_KEY = 'unit-test-encryption-key-do-not-use-in-prod'

import {
  deriveConnectionHealth,
  connectionNeedsReauth,
  summarizeSyncEvent,
  redactSyncMessage,
  redactSyncMetadata,
  MAX_SYNC_MESSAGE_LEN,
  SYNC_EVENT_KINDS,
} from '../_utils'

/**
 * Mercado Libre module · Sprint 5 pure helpers (US-13 resilience).
 * No DB, no network. Proves: the `needs_reauth` health state outranks the
 * time-derived states, and the activity-log event shaper validates + redacts.
 */

describe('deriveConnectionHealth — needs_reauth (S5)', () => {
  const future = new Date(Date.now() + 60 * 60 * 1000) // 1h out → would be "connected"
  const past = new Date(Date.now() - 60 * 60 * 1000) // 1h ago → would be "expired"

  it('returns needs_reauth when metadata flags it, outranking a healthy expiry', () => {
    const h = deriveConnectionHealth({ status: 'connected', expires_at: future, metadata: { needs_reauth: true } })
    expect(h.state).toBe('needs_reauth')
    expect(h.label_es).toMatch(/Reconecta/i)
  })

  it('returns needs_reauth even when the token is also expired', () => {
    const h = deriveConnectionHealth({ status: 'connected', expires_at: past, metadata: { needs_reauth: true } })
    expect(h.state).toBe('needs_reauth')
  })

  it('does not flag needs_reauth without the metadata flag', () => {
    expect(deriveConnectionHealth({ status: 'connected', expires_at: future }).state).toBe('connected')
    expect(deriveConnectionHealth({ status: 'connected', expires_at: future, metadata: { sync_enabled: true } }).state).toBe('connected')
  })

  it('a disconnected connection is disconnected regardless of the reauth flag', () => {
    expect(deriveConnectionHealth({ status: 'disconnected', expires_at: future, metadata: { needs_reauth: true } }).state).toBe('disconnected')
  })

  it('connectionNeedsReauth is strict on the boolean true', () => {
    expect(connectionNeedsReauth({ needs_reauth: true })).toBe(true)
    expect(connectionNeedsReauth({ needs_reauth: 'true' as unknown as boolean })).toBe(false)
    expect(connectionNeedsReauth(null)).toBe(false)
    expect(connectionNeedsReauth({})).toBe(false)
  })
})

describe('summarizeSyncEvent — validate + shape (S5)', () => {
  it('accepts every known kind', () => {
    for (const kind of SYNC_EVENT_KINDS) {
      const shaped = summarizeSyncEvent({ sellerId: 'sel_1', kind, outcome: 'ok' })
      expect(shaped?.kind).toBe(kind)
    }
  })

  it('drops an unknown kind (returns null — the log never writes garbage)', () => {
    expect(summarizeSyncEvent({ sellerId: 'sel_1', kind: 'not_a_kind', outcome: 'ok' })).toBeNull()
  })

  it('drops a missing seller', () => {
    expect(summarizeSyncEvent({ sellerId: '', kind: 'publish', outcome: 'ok' })).toBeNull()
    expect(summarizeSyncEvent({ sellerId: '   ', kind: 'publish', outcome: 'ok' })).toBeNull()
  })

  it('normalises outcome to ok|fail', () => {
    expect(summarizeSyncEvent({ sellerId: 's', kind: 'publish', outcome: 'fail' })?.outcome).toBe('fail')
    expect(summarizeSyncEvent({ sellerId: 's', kind: 'publish', outcome: 'weird' })?.outcome).toBe('ok')
  })

  it('nulls product/ml/code/metadata when absent', () => {
    const shaped = summarizeSyncEvent({ sellerId: 's', kind: 'reconcile', outcome: 'ok' })
    expect(shaped).toMatchObject({ product_id: null, ml_item_id: null, code: null, message: null, metadata: null })
  })
})

describe('redactSyncMessage — never leak a token (S5)', () => {
  it('redacts an ML access/refresh token', () => {
    const msg = redactSyncMessage('refresh failed for APP_USR-1234567890-abcdef-secret token')
    expect(msg).not.toMatch(/APP_USR-1234567890/)
    expect(msg).toMatch(/\[redacted\]/)
  })

  it('redacts a bearer header and a JWT', () => {
    expect(redactSyncMessage('Authorization: Bearer abc.def-123')).toMatch(/Bearer \[redacted\]/)
    expect(redactSyncMessage('token eyJhbGciOi.eyJzdWIi.sig-part_9')).toMatch(/\[redacted\]/)
  })

  it('truncates an over-long message', () => {
    const long = 'x'.repeat(MAX_SYNC_MESSAGE_LEN + 50)
    const out = redactSyncMessage(long)!
    expect(out.length).toBeLessThanOrEqual(MAX_SYNC_MESSAGE_LEN)
    expect(out.endsWith('…')).toBe(true)
  })

  it('returns null for empty / nullish', () => {
    expect(redactSyncMessage(null)).toBeNull()
    expect(redactSyncMessage('   ')).toBeNull()
  })
})

describe('redactSyncMetadata — caller-provided metadata cannot leak a token (S5)', () => {
  it('redacts a token in a string value but keeps scalars', () => {
    const out = redactSyncMetadata({ note: 'token APP_USR-999-secret', available: 5, ok: true, none: null })
    expect(out).toEqual({ note: expect.stringContaining('[redacted]'), available: 5, ok: true, none: null })
    expect(JSON.stringify(out)).not.toMatch(/APP_USR-999/)
  })

  it('drops nested objects/arrays (stays a flat scalar bag)', () => {
    const out = redactSyncMetadata({ good: 1, nested: { token: 'APP_USR-1-x' }, arr: ['APP_USR-2-y'] })
    expect(out).toEqual({ good: 1 })
  })

  it('returns null for nullish', () => {
    expect(redactSyncMetadata(null)).toBeNull()
    expect(redactSyncMetadata(undefined)).toBeNull()
  })
})
