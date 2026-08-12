/**
 * The Clerk instance identity seam: which Frontend API host we are talking to, and
 * which `iss` a token from it must carry.
 *
 * This exists as ONE module because it used to exist as two, and the same bug was in
 * both. `api/store/_utils/clerk-verify.ts` and `modules/auth-clerk/service.ts` each
 * had their own `getFrontendApiFromKey` and each built the issuer as
 * `https://clerk.${frontendApi}` — wrong for both key shapes, since the live key
 * already decodes to `clerk.miyagisanchez.com` and that expression asks for
 * `https://clerk.clerk.miyagisanchez.com`. Both therefore always threw on the issuer
 * check and both caught it and retried with no issuer check at all.
 *
 * Fixing one copy and leaving the other is how a class of bug survives its own fix.
 * There is one copy now.
 */

/**
 * Extract the Clerk Frontend API host from the publishable key.
 * pk_test_aG9uZXN0LWVlbC0zOS5jbGVyay5hY2NvdW50cy5kZXYk → honest-eel-39.clerk.accounts.dev
 * pk_live_Y2xlcmsubWl5YWdpc2FuY2hlei5jb20k              → clerk.miyagisanchez.com
 */
export function getFrontendApiFromKey(publishableKey: string): string {
  return Buffer.from(publishableKey.replace(/^pk_(test|live)_/, ''), 'base64')
    .toString('utf-8')
    .replace(/\$$/, '')
}

export function jwksUrl(frontendApi: string): string {
  return `https://${frontendApi}/.well-known/jwks.json`
}

/**
 * The derived issuer — a Clerk instance's issuer is its Frontend API origin.
 *
 * Confirmed against the live instance on 2026-08-12:
 *   GET https://clerk.miyagisanchez.com/.well-known/openid-configuration
 *   → {"issuer":"https://clerk.miyagisanchez.com", ...}
 *
 * This is the FALLBACK. `resolveClerkIssuer` prefers what the instance publishes,
 * because an issuer this code DERIVES can be wrong — it already was once, and being
 * wrong here locks every seller out of their own portal.
 */
export function clerkIssuer(frontendApi: string): string {
  return `https://${frontendApi}`
}

// A SUCCESS is cached for the process lifetime — the issuer of a Clerk instance does
// not change under it. A FAILURE is cached too, briefly: without that, every token
// verification during a discovery outage pays the full 5s timeout before falling back,
// turning a degraded dependency into a degraded API. Caching it forever would be the
// opposite mistake — the derived fallback would outlive the outage and we would never
// pick the published issuer back up.
const DISCOVERY_FAILURE_TTL_MS = 60_000
const _issuerByHost = new Map<string, { issuer: string; expiresAt: number }>()

/** Test seam: the caches are process-lifetime by design, so specs must be able to clear them. */
export function __resetClerkIssuerCache(): void {
  _issuerByHost.clear()
}

/**
 * The issuer to enforce, read from the instance's own OIDC discovery document.
 *
 * Falls back to the derived origin when discovery is unreachable — a Clerk outage must
 * not silently DISABLE the issuer check, and must not lock out every seller either.
 * Both paths still require a valid signature from the instance's JWKS, which is what
 * actually makes a forged `sub` impossible; the issuer check is defence in depth.
 */
export async function resolveClerkIssuer(frontendApi: string): Promise<string> {
  const cached = _issuerByHost.get(frontendApi)
  if (cached && cached.expiresAt > Date.now()) return cached.issuer

  const fallback = clerkIssuer(frontendApi)
  const remember = (issuer: string, ttlMs: number) => {
    _issuerByHost.set(frontendApi, { issuer, expiresAt: Date.now() + ttlMs })
    return issuer
  }

  try {
    const res = await fetch(`https://${frontendApi}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return remember(fallback, DISCOVERY_FAILURE_TTL_MS)
    const doc = (await res.json()) as { issuer?: unknown }
    // A discovery document that does not name an https issuer is a failed read, not a
    // licence to accept what it says — an http issuer would be a downgrade.
    if (typeof doc.issuer !== 'string' || !doc.issuer.startsWith('https://')) {
      return remember(fallback, DISCOVERY_FAILURE_TTL_MS)
    }
    return remember(doc.issuer, Number.POSITIVE_INFINITY)
  } catch {
    return remember(fallback, DISCOVERY_FAILURE_TTL_MS)
  }
}

/**
 * Name an issuer mismatch in the logs, then let the caller refuse.
 *
 * Removing the retry-without-issuer-check is the right call and it removes the safety
 * net at the same time: if real tokens turned out to carry an `iss` we do not expect,
 * every seller is locked out of their portal and the logs would only say "invalid
 * JWT". That is a long, expensive diagnosis for a one-line cause.
 *
 * So on a verification failure we read the UNVERIFIED `iss` — purely to print it — and
 * say what we expected. This grants nothing: the token is still refused. It only turns
 * an hour of guessing into one log line.
 */
export function logIssuerMismatch(source: string, token: string, expectedIssuer: string): void {
  try {
    const claimed = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'),
    ) as { iss?: unknown }
    if (typeof claimed.iss === 'string' && claimed.iss !== expectedIssuer) {
      console.error(
        `[${source}] ISSUER MISMATCH — token claims iss=${claimed.iss}, expected ${expectedIssuer}. ` +
          'The token is refused. If this is legitimate traffic, the expected issuer is wrong.',
      )
    }
  } catch {
    // An unparseable token is just an invalid token; the caller already refuses it.
  }
}
