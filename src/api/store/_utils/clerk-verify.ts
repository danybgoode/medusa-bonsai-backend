/**
 * Cryptographic Clerk JWT verification for custom Store API routes.
 *
 * Why this exists separately from `clerk-auth.ts`:
 * `extractClerkUserId` used to only base64-DECODE the JWT payload (no signature
 * check), on the documented assumption that "Clerk's public key validation happens
 * at the edge (middleware)". That assumption was FALSE — there was no
 * `src/api/middlewares.ts` in this repo at all, so a `sub` claim was forgeable and
 * every `/store/sellers/me/*` and `/store/buyer/me/*` route trusted it. Anyone could
 * mint `{"sub":"user_<someone-else>"}`, base64 it into a three-part string and read
 * or write another shop's orders, products, payouts and Stripe onboarding.
 *
 * `src/api/middlewares.ts` now runs `verifyClerkJwt` over that whole population and
 * records the result here; `clerk-auth.ts` reads ONLY what this module verified.
 *
 * Dependency-light on purpose (only `jose` + env): a route AND its unit spec can
 * import it without dragging the Medusa auth module in.
 */

import type { MedusaRequest } from '@medusajs/framework/http'

/**
 * Extract the Clerk Frontend API host from the publishable key.
 * pk_test_aG9uZXN0LWVlbC0zOS5jbGVyay5hY2NvdW50cy5kZXYk → honest-eel-39.clerk.accounts.dev
 * pk_live_Y2xlcmsubWl5YWdpc2FuY2hlei5jb20k              → clerk.miyagisanchez.com
 * (mirrors `getFrontendApiFromKey` in src/modules/auth-clerk/service.ts).
 */
export function getFrontendApiFromKey(publishableKey: string): string {
  const stripped = publishableKey.replace(/^pk_(test|live)_/, '')
  return Buffer.from(stripped, 'base64').toString('utf-8').replace(/\$$/, '')
}

/**
 * The token issuer for a Clerk instance is its Frontend API origin.
 *
 * This was previously built as `https://clerk.${frontendApi}`, which is wrong for
 * BOTH key shapes — the live key decodes to `clerk.miyagisanchez.com`, giving
 * `https://clerk.clerk.miyagisanchez.com`, and a dev key decodes to
 * `<slug>.clerk.accounts.dev`, giving `https://clerk.<slug>.clerk.accounts.dev`.
 * The issuer check therefore ALWAYS threw, and the old code caught that and retried
 * with no issuer check at all — so no token was ever issuer-bound.
 *
 * Confirmed against the live instance on 2026-08-12:
 *   GET https://clerk.miyagisanchez.com/.well-known/openid-configuration
 *   → {"issuer":"https://clerk.miyagisanchez.com", ...}
 *
 * This is the FALLBACK only. `resolveClerkIssuer` below prefers the value the
 * instance publishes about itself, because an issuer this code DERIVES can be wrong
 * — it already was once, and being wrong here locks every seller out of their own
 * portal. An issuer the instance publishes cannot be.
 */
export function clerkIssuer(frontendApi: string): string {
  return `https://${frontendApi}`
}

// One discovery call per host, cached for the process lifetime alongside the JWKS.
const _issuerByHost = new Map<string, string>()

/**
 * The issuer to enforce, read from the instance's own OIDC discovery document.
 *
 * Falls back to the derived origin when discovery is unreachable — a Clerk outage
 * must not silently DISABLE the issuer check, and it must not lock out every seller
 * either. Both paths still require a valid signature from the instance's JWKS, which
 * is what actually makes a forged `sub` impossible; the issuer check is defence in
 * depth on top of it.
 */
export async function resolveClerkIssuer(frontendApi: string): Promise<string> {
  const cached = _issuerByHost.get(frontendApi)
  if (cached) return cached
  const fallback = clerkIssuer(frontendApi)
  try {
    const res = await fetch(`https://${frontendApi}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return fallback
    const doc = (await res.json()) as { issuer?: unknown }
    if (typeof doc.issuer !== 'string' || !doc.issuer.startsWith('https://')) return fallback
    _issuerByHost.set(frontendApi, doc.issuer)
    return doc.issuer
  } catch {
    return fallback
  }
}

export interface VerifiedClerkUser {
  sub: string
  email?: string
}

// jose's createRemoteJWKSet returns a resolver that caches the fetched key set; build
// it ONCE per Clerk frontend host (a hot homepage endpoint would otherwise re-fetch
// JWKS every request). Keyed by host so a key rotation is still picked up by jose's
// own cache TTL within the resolver.
const _jwksByHost = new Map<string, Awaited<ReturnType<typeof loadJwks>>>()
async function loadJwks(frontendApi: string) {
  const { createRemoteJWKSet } = await import('jose')
  return createRemoteJWKSet(new URL(`https://${frontendApi}/.well-known/jwks.json`))
}
async function getJwks(frontendApi: string) {
  const cached = _jwksByHost.get(frontendApi)
  if (cached) return cached
  const jwks = await loadJwks(frontendApi)
  _jwksByHost.set(frontendApi, jwks)
  return jwks
}

/** Pull the bearer token from the Authorization header (or null). */
export function bearerToken(req: MedusaRequest): string | null {
  const header = req.headers['authorization'] as string | undefined
  const token = header?.replace(/^Bearer\s+/i, '')
  return token && token.length > 0 ? token : null
}

/**
 * Verify a Clerk session JWT against Clerk's JWKS and return its `sub` (+ email).
 * Returns `null` for a missing / malformed / unverifiable token, or when the
 * publishable key env is absent — callers respond 401 on null.
 */
export async function verifyClerkJwt(token: string | null): Promise<VerifiedClerkUser | null> {
  if (!token) return null

  const pk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  if (!pk) {
    console.error('[clerk-verify] NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY not set')
    return null
  }

  // Dynamic import — matches auth-clerk's CommonJS/ESM-safe pattern for jose.
  const { jwtVerify } = await import('jose')
  const frontendApi = getFrontendApiFromKey(pk)
  const jwks = await getJwks(frontendApi)

  let payload: { sub?: string; email?: string; email_address?: string }
  try {
    const { payload: p } = await jwtVerify(token, jwks, {
      issuer: await resolveClerkIssuer(frontendApi),
      // Clerk session tokens live ~60s and the client refreshes them continuously,
      // so a request in flight across a container's clock skew is normal traffic,
      // not an attack. 30s is well inside the token lifetime.
      clockTolerance: 30,
    })
    payload = p as typeof payload
  } catch (e) {
    // NO fallback retry without the issuer check. The old code had one, and because
    // the issuer it built never matched, that fallback was the only path that ever
    // ran — a token from any Clerk instance in the world would have verified.
    console.warn('[clerk-verify] invalid JWT:', (e as Error).message)
    return null
  }

  if (!payload.sub) return null
  return { sub: payload.sub, email: payload.email ?? payload.email_address }
}

// ── Verified identity, carried on the request ────────────────────────────────
//
// A WeakMap rather than a property on `req`: nothing a caller can send (header,
// query, body) can reach into it, and there is no type augmentation to keep in sync.
//
// THREE states, not two — `undefined` (the middleware never ran for this request)
// is a different fact from `null` (it ran and the token did not verify). A route
// that consumes identity on a request the middleware never saw is a MATCHER GAP:
// it denies the request either way, but silently, so `readVerifiedClerkIdentity`
// makes it loud instead of letting the guard decay unnoticed.
const _verified = new WeakMap<object, VerifiedClerkUser | null>()

export function recordVerifiedClerkIdentity(req: MedusaRequest, identity: VerifiedClerkUser | null): void {
  _verified.set(req as unknown as object, identity)
}

export type ClerkIdentityState =
  | { readonly state: 'verified'; readonly identity: VerifiedClerkUser }
  | { readonly state: 'unverified' }
  | { readonly state: 'not_checked' }

export function readVerifiedClerkIdentity(req: MedusaRequest): ClerkIdentityState {
  const key = req as unknown as object
  if (!_verified.has(key)) {
    if (bearerToken(req)) {
      // A bearer arrived at a route that consumes Clerk identity, and no middleware
      // verified it. That is a hole in the middleware matchers — name it.
      console.error(
        '[clerk-verify] MATCHER GAP: a route consumed Clerk identity but no verification middleware ran.',
        (req as unknown as { originalUrl?: string; url?: string }).originalUrl ??
          (req as unknown as { url?: string }).url ??
          '(unknown path)',
      )
    }
    return { state: 'not_checked' }
  }
  const identity = _verified.get(key) ?? null
  return identity ? { state: 'verified', identity } : { state: 'unverified' }
}
