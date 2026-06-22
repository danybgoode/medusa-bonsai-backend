/**
 * Cryptographic Clerk JWT verification for custom Store API routes.
 *
 * Why this exists separately from `clerk-auth.ts`:
 * `extractClerkUserId` only base64-DECODES the JWT payload (no signature check) — it
 * assumes upstream edge validation. There is no `src/api/middlewares.ts` doing that,
 * so a decoded `sub` is forgeable. For a NEW cross-origin endpoint that returns a
 * user's own (money-adjacent) data, we verify the token's signature here, against
 * Clerk's JWKS — the same `jose` flow the `auth-clerk` module uses
 * (`src/modules/auth-clerk/service.ts`).
 *
 * Dependency-light on purpose (only `jose` + env): the route AND its unit spec import
 * it without dragging the Medusa auth module in.
 */

import type { MedusaRequest } from '@medusajs/framework/http'

/**
 * Extract the Clerk Frontend API host from the publishable key.
 * pk_test_aG9uZXN0LWVlbC0zOS5jbGVyay5hY2NvdW50cy5kZXYk → honest-eel-39.clerk.accounts.dev
 * (mirrors `getFrontendApiFromKey` in src/modules/auth-clerk/service.ts).
 */
export function getFrontendApiFromKey(publishableKey: string): string {
  const stripped = publishableKey.replace(/^pk_(test|live)_/, '')
  return Buffer.from(stripped, 'base64').toString('utf-8').replace(/\$$/, '')
}

export interface VerifiedClerkUser {
  sub: string
  email?: string
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
  const { createRemoteJWKSet, jwtVerify } = await import('jose')
  const frontendApi = getFrontendApiFromKey(pk)
  const jwks = createRemoteJWKSet(new URL(`https://${frontendApi}/.well-known/jwks.json`))

  let payload: { sub?: string; email?: string; email_address?: string }
  try {
    const { payload: p } = await jwtVerify(token, jwks, {
      issuer: `https://clerk.${frontendApi}`,
    })
    payload = p as typeof payload
  } catch {
    // Clerk dev/test tokens use a different issuer format — retry without issuer check.
    try {
      const { payload: p } = await jwtVerify(token, jwks)
      payload = p as typeof payload
    } catch (e) {
      console.warn('[clerk-verify] invalid JWT:', (e as Error).message)
      return null
    }
  }

  if (!payload.sub) return null
  return { sub: payload.sub, email: payload.email ?? payload.email_address }
}
