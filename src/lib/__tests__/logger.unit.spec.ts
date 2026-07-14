/**
 * logger unit specs (deploy-pipeline-tuning S5.1) — proves the pure entry-builder shape that
 * Cloud Logging depends on, and the Error-serialization gotcha found migrating real call sites.
 */
import { buildLogEntry } from '../logger'

describe('buildLogEntry', () => {
  it('sets severity, a bracket-prefixed message, and a structured tag field', () => {
    const entry = buildLogEntry('ERROR', 'profit-ledger', 'appendOrderLedger failed (non-fatal)')
    expect(entry.severity).toBe('ERROR')
    expect(entry.message).toBe('[profit-ledger] appendOrderLedger failed (non-fatal)')
    expect(entry.tag).toBe('profit-ledger')
  })

  it('merges extra fields onto the entry', () => {
    const entry = buildLogEntry('INFO', 'mp', 'token refreshed', { sellerId: 'sel_1' })
    expect(entry.sellerId).toBe('sel_1')
  })

  it('flattens an Error field into a plain {message,name,stack} object instead of dropping it', () => {
    const err = new Error('boom')
    const entry = buildLogEntry('ERROR', 'mp', 'token refresh error', { error: err })
    // the regression this guards against: JSON.stringify(new Error(...)) === '{}'
    expect(JSON.stringify(err)).toBe('{}')
    expect(entry.error).toEqual({ message: 'boom', name: 'Error', stack: err.stack })
  })

  it('round-trips through JSON.stringify with the error still present', () => {
    const entry = buildLogEntry('ERROR', 'mp-ipn', 'session patch failed for cart', {
      cartId: 'cart_1',
      error: new Error('patch failed'),
    })
    const parsed = JSON.parse(JSON.stringify(entry))
    expect(parsed.error.message).toBe('patch failed')
    expect(parsed.cartId).toBe('cart_1')
  })

  it('leaves non-Error field values untouched', () => {
    const entry = buildLogEntry('ERROR', 'mp', 'token refresh failed', { response: { error: 'invalid_grant' } })
    expect(entry.response).toEqual({ error: 'invalid_grant' })
  })
})
