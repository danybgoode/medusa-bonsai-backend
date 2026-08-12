import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { verifyClerkIdentity } from '../middlewares'
import { extractClerkEmail, extractClerkUserId } from '../store/_utils/clerk-auth'
import {
  clerkIssuer,
  getFrontendApiFromKey,
  readVerifiedClerkIdentity,
  recordVerifiedClerkIdentity,
  resolveClerkIssuer,
} from '../store/_utils/clerk-verify'

/**
 * The behaviour of the verification seam, DB- and network-free.
 *
 * The middleware's only dependency on the network is `verifyClerkJwt`, so these tests
 * drive the middleware with a stubbed verifier and assert what it records — plus what
 * the readers do with each of the three recorded states.
 */

const req = (headers: Record<string, string> = {}) =>
  ({ headers, originalUrl: '/store/sellers/me' }) as unknown as MedusaRequest
const res = () => ({}) as MedusaResponse

describe('clerkIssuer', () => {
  /**
   * The regression that made verification decorative. `https://clerk.${frontendApi}`
   * never matched a real issuer, so the code's issuer branch always threw and its
   * catch retried with NO issuer check — meaning any Clerk instance's token verified.
   * Asserted against both live key shapes.
   */
  it('is the Frontend API origin itself, not a clerk-prefixed one', () => {
    expect(clerkIssuer(getFrontendApiFromKey('pk_live_Y2xlcmsubWl5YWdpc2FuY2hlei5jb20k')))
      .toBe('https://clerk.miyagisanchez.com')
    expect(clerkIssuer(getFrontendApiFromKey('pk_test_aG9uZXN0LWVlbC0zOS5jbGVyay5hY2NvdW50cy5kZXYk')))
      .toBe('https://honest-eel-39.clerk.accounts.dev')
  })
})

describe('resolveClerkIssuer', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch })

  it('prefers what the instance publishes about itself', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ issuer: 'https://clerk.example.test' }),
    }) as unknown as typeof fetch
    await expect(resolveClerkIssuer('published.example.test')).resolves.toBe('https://clerk.example.test')
  })

  it('falls back to the derived origin when discovery is unreachable', async () => {
    // A Clerk outage must not silently DISABLE the issuer check, and must not lock
    // every seller out either. Signature verification is unaffected on both paths.
    global.fetch = jest.fn().mockRejectedValue(new Error('ENOTFOUND')) as unknown as typeof fetch
    await expect(resolveClerkIssuer('offline.example.test')).resolves.toBe('https://offline.example.test')
  })

  it('does not re-discover on every verification — success is cached', async () => {
    const f = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ issuer: 'https://cached.example.test' }) })
    global.fetch = f as unknown as typeof fetch
    await resolveClerkIssuer('cache-hit.example.test')
    await resolveClerkIssuer('cache-hit.example.test')
    await resolveClerkIssuer('cache-hit.example.test')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('does not re-discover on every verification during an outage either', async () => {
    // Found by the Antigravity cross-family pass on PR #148: without a negative cache,
    // every token verification during a discovery outage pays the full 5s timeout
    // first, so a degraded dependency becomes a degraded API.
    const f = jest.fn().mockRejectedValue(new Error('ETIMEDOUT'))
    global.fetch = f as unknown as typeof fetch
    await resolveClerkIssuer('outage.example.test')
    await resolveClerkIssuer('outage.example.test')
    await resolveClerkIssuer('outage.example.test')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('retries discovery after the failure TTL — the fallback must not outlive the outage', async () => {
    const f = jest.fn().mockRejectedValue(new Error('ETIMEDOUT'))
    global.fetch = f as unknown as typeof fetch
    await resolveClerkIssuer('recovers.example.test')

    // A negative entry cached forever would pin the derived issuer permanently and we
    // would never pick the published one back up.
    const realNow = Date.now
    Date.now = () => realNow() + 61_000
    try {
      f.mockResolvedValue({ ok: true, json: async () => ({ issuer: 'https://recovered.example.test' }) })
      await expect(resolveClerkIssuer('recovers.example.test')).resolves.toBe('https://recovered.example.test')
    } finally {
      Date.now = realNow
    }
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('refuses a discovery document that does not name an https issuer', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ issuer: 'http://downgraded.example.test' }),
    }) as unknown as typeof fetch
    await expect(resolveClerkIssuer('downgrade.example.test')).resolves.toBe('https://downgrade.example.test')
  })
})

describe('identity states', () => {
  it('a request the middleware never saw is not_checked, and yields no identity', () => {
    const r = req({ authorization: 'Bearer forged.token.here' })
    expect(readVerifiedClerkIdentity(r)).toEqual({ state: 'not_checked' })
    expect(extractClerkUserId(r)).toBeNull()
  })

  it('a verified token yields its sub and email', () => {
    const r = req()
    recordVerifiedClerkIdentity(r, { sub: 'user_real', email: 'a@b.com' })
    expect(extractClerkUserId(r)).toBe('user_real')
    expect(extractClerkEmail(r)).toBe('a@b.com')
  })

  it('an unverified token yields NOTHING — this is the whole fix', () => {
    const r = req({ authorization: 'Bearer forged.token.here' })
    recordVerifiedClerkIdentity(r, null)
    expect(readVerifiedClerkIdentity(r)).toEqual({ state: 'unverified' })
    expect(extractClerkUserId(r)).toBeNull()
    expect(extractClerkEmail(r)).toBeNull()
  })

  it('distinguishes "not checked" from "checked and anonymous"', () => {
    // Three states, never two: a matcher gap and a genuinely anonymous guest must not
    // be the same fact, or the gap is invisible for as long as it exists.
    const anonymous = req()
    recordVerifiedClerkIdentity(anonymous, null)
    expect(readVerifiedClerkIdentity(anonymous).state).toBe('unverified')
    expect(readVerifiedClerkIdentity(req()).state).toBe('not_checked')
  })
})

describe('verifyClerkIdentity middleware', () => {
  const originalKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  afterEach(() => {
    if (originalKey === undefined) delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
    else process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = originalKey
  })

  it('records anonymous and continues when there is no bearer', async () => {
    const r = req()
    const next = jest.fn()
    await verifyClerkIdentity(r, res(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(readVerifiedClerkIdentity(r)).toEqual({ state: 'unverified' })
  })

  it('grants NO identity for a forged token, and still calls next()', async () => {
    // No publishable key configured ⇒ verifyClerkJwt returns null. That is the same
    // path a bad signature takes, and it must never become an identity.
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
    const forged = Buffer.from(JSON.stringify({ sub: 'user_someone_else' })).toString('base64url')
    const r = req({ authorization: `Bearer eyJhbGciOiJub25lIn0.${forged}.` })
    const next = jest.fn()

    await verifyClerkIdentity(r, res(), next)

    expect(extractClerkUserId(r)).toBeNull()
    // Guest checkout runs through this same middleware: denying identity must not
    // deny the request.
    expect(next).toHaveBeenCalledTimes(1)
  })
})
