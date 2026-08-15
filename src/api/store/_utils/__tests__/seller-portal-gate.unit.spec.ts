import { decidePortalGate, isWriteMethod } from '../seller-portal-gate'

/**
 * The seller-portal write gate (tenant-lifecycle-admin · D2c).
 *
 * Two properties carry the story and both are asymmetric, so both are tested from
 * both sides: a paused merchant can still SEE their shop, and cannot CHANGE it.
 */
describe('isWriteMethod', () => {
  it('treats every mutating method as a write, case-insensitively', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'patch']) {
      expect(isWriteMethod(method)).toBe(true)
    }
  })

  it('treats reads as reads', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(isWriteMethod(method)).toBe(false)
    }
  })

  it('a missing or non-string method is not a write', () => {
    // The gate must not refuse on a shape it does not understand — the route's own
    // handling is the fallback, and a middleware that 423s an OPTIONS preflight
    // breaks CORS for everyone.
    for (const method of [undefined, null, 42, {}]) expect(isWriteMethod(method)).toBe(false)
  })
})

describe('decidePortalGate', () => {
  it('lets an ACTIVE seller write', () => {
    expect(decidePortalGate({ method: 'POST', seller: { status: 'active' } })).toBeNull()
  })

  it('lets a paused seller READ — they must still see their own shop', () => {
    for (const method of ['GET', 'HEAD']) {
      expect(decidePortalGate({ method, seller: { status: 'paused' } })).toBeNull()
    }
  })

  it('REFUSES a paused seller writing, with 423 and a state the portal can render', () => {
    const refusal = decidePortalGate({ method: 'POST', seller: { status: 'paused' } })
    expect(refusal?.status).toBe(423)
    if (refusal?.status !== 423) throw new Error('expected a 423')
    expect(refusal.body.code).toBe('seller_not_active')
    expect(refusal.body.seller_status).toBe('paused')
    expect(refusal.body.message).toContain('pausa')
  })

  it('REFUSES a deleted seller writing, and says something DIFFERENT from paused', () => {
    // A merchant reading "en pausa" when the account is gone would be misled about
    // whether it can come back. The two states get different copy on purpose.
    const paused = decidePortalGate({ method: 'DELETE', seller: { status: 'paused' } })
    const deleted = decidePortalGate({ method: 'DELETE', seller: { status: 'deleted' } })
    if (paused?.status !== 423 || deleted?.status !== 423) throw new Error('expected two 423s')
    expect(deleted.body.seller_status).toBe('deleted')
    expect(deleted.body.message).not.toBe(paused.body.message)
  })

  it('REFUSES an UNREADABLE status as a RETRYABLE 503, not a 423', () => {
    // 423 means "your account is paused" — a durable fact the merchant must act on.
    // 503 means "try again" — our problem, not theirs. Telling a healthy merchant
    // their account was paused because a value failed to parse would be a lie.
    const refusal = decidePortalGate({ method: 'PATCH', seller: { status: 'nonsense' } })
    expect(refusal?.status).toBe(503)
    if (refusal?.status !== 503) throw new Error('expected a 503')
    expect(refusal.body.code).toBe('seller_status_unavailable')
  })

  it('FAILS CLOSED when the lookup itself failed — the finding from review round 1', () => {
    // An earlier revision called next() on a lookup error, so inducing a transient
    // failure granted exactly the mutation this gate prohibits. It now refuses,
    // retryably.
    const refusal = decidePortalGate({ method: 'POST', seller: 'unavailable' })
    expect(refusal?.status).toBe(503)
    if (refusal?.status !== 503) throw new Error('expected a 503')
    expect(refusal.body.code).toBe('seller_status_unavailable')
  })

  it('a failed lookup on a READ still passes — reads were never gated', () => {
    expect(decidePortalGate({ method: 'GET', seller: 'unavailable' })).toBeNull()
  })

  it('PASSES THROUGH when there is no seller — "not a seller yet" is not "locked"', () => {
    // Refusing here would break onboarding: a signed-in user with no shop would be
    // told their account is paused.
    for (const seller of [null, undefined]) {
      expect(decidePortalGate({ method: 'POST', seller })).toBeNull()
    }
  })

  it('a seller row WITHOUT the status column passes — it predates the migration', () => {
    // parseSellerStatus treats an absent column as the default. A projection that did
    // not select `status` must not lock a healthy merchant out.
    expect(decidePortalGate({ method: 'POST', seller: {} })).toBeNull()
  })

  it('every refusal carries non-empty es-MX copy — this reaches a merchant screen', () => {
    for (const seller of [{ status: 'paused' }, { status: 'deleted' }, { status: 'nonsense' }, 'unavailable' as const]) {
      const refusal = decidePortalGate({ method: 'POST', seller })
      expect(refusal?.body.message.length ?? 0).toBeGreaterThan(20)
    }
  })
})
