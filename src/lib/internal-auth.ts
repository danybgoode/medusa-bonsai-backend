/**
 * internal-auth.ts — THE definition of "is this caller allowed to hit an internal
 * route", stated once so it cannot drift permissive in 30 copies.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUG THIS EXISTS TO KILL
 *
 * Three fail-OPEN shapes were live in this repo simultaneously, all saying the same
 * wrong thing — "if the secret is not configured, let everyone in":
 *
 *     return !secret || provided === secret            // authed()       — 7 sites
 *     if (internalSecret && header !== internalSecret) // inline guard   — 6 sites
 *     return !!expected && got !== expected            // unauthorized() — 2 sites
 *
 * `LEARNINGS.md` names this exact anti-pattern, and its corollary is why all fifteen
 * were fixed together rather than only the one a reviewer found: THE SHAPE GETS
 * COPY-PASTED. Guard the population, not the door you found.
 *
 * A missing secret is a MISCONFIGURED DEPLOY, which is precisely the moment an
 * unauthenticated caller must not be able to prune sales channels, stamp sellers,
 * relink products or capture payments. Absent configuration ⇒ denied. Always.
 *
 * (This is not a live-behaviour change: ~22 sibling internal routes — the whole
 * `ml/*`, `sellers/*` and `seller-products/*` surface, all in daily production use —
 * already denied on a missing secret. Production could not be serving those and have
 * the var unset, so inverting the other fifteen changes nothing in prod and closes
 * the hole everywhere else.)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Pure over an injected env so the "env unset" branch is unit-testable — that branch
 * is the whole point and it is unreachable from a normal test run otherwise.
 */

/** Just enough of a request to read the header off. Keeps this dependency-free. */
export interface InternalSecretCarrier {
  readonly headers: Record<string, unknown>
}

export const INTERNAL_SECRET_HEADER = 'x-internal-secret'

/**
 * True only when the server HAS a secret configured and the caller presented it.
 *
 * Every clause below denies:
 *   · env var absent / empty / whitespace  ⇒ false (the fail-closed case)
 *   · header absent or not a string        ⇒ false
 *   · header present but different         ⇒ false
 */
export function internalSecretOk(
  req: InternalSecretCarrier,
  env: { MEDUSA_INTERNAL_SECRET?: string } = process.env,
): boolean {
  const expected = typeof env.MEDUSA_INTERNAL_SECRET === 'string'
    ? env.MEDUSA_INTERNAL_SECRET.trim()
    : ''
  if (!expected) return false

  const got = req?.headers?.[INTERNAL_SECRET_HEADER]
  if (typeof got !== 'string') return false
  return got === expected
}

/**
 * The negation, for the many call sites whose local guard is named `unauthorized()`.
 * Provided so those sites read naturally instead of sprinkling `!` — and so neither
 * polarity is ever re-derived at a call site, which is how one of them got inverted.
 */
export function internalSecretMissing(
  req: InternalSecretCarrier,
  env: { MEDUSA_INTERNAL_SECRET?: string } = process.env,
): boolean {
  return !internalSecretOk(req, env)
}
