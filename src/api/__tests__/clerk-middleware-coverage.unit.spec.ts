import { readFileSync, readdirSync } from 'fs'
import { join, relative, sep } from 'path'
import { CLERK_VERIFIED_MATCHERS } from '../middlewares'

/**
 * THE POPULATION GUARD for Clerk identity verification.
 *
 * `src/api/middlewares.ts` is what makes a `sub` claim mean anything: without it,
 * `extractClerkUserId` was returning an attacker-supplied string and every
 * `/store/sellers/me/**` route authenticated on it. The fix is only as good as its
 * coverage, so coverage is derived here — never listed.
 *
 * Guard the population, not the door you found (LEARNINGS): the finding that started
 * this named ONE route, `sellers/me/stripe-connect`, because that was the new one.
 * Thirty-seven siblings had the identical hole. A guard that hand-picks its roots
 * decays while still passing, so this spec globs every `route.ts` under `src/api`, derives which
 * files consume Clerk identity, and asserts each one's URL is covered by a matcher.
 *
 * cwd is the package root under jest, same convention as `market-boundary-population`.
 */

const API_ROOT = join(process.cwd(), 'src/api')

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith(`${sep}route.ts`) || entry === 'route.ts')
    .map((entry) => join(dir, entry))
}

const read = (file: string) => readFileSync(file, 'utf8')
const rel = (file: string) => relative(process.cwd(), file)

/** `src/api/store/sellers/me/orders/[id]/route.ts` → `/store/sellers/me/orders/:id` */
function urlPath(file: string): string {
  return (
    '/' +
    rel(file)
      .split(sep)
      .slice(2, -1) // drop `src`, `api`, and the trailing `route.ts`
      .map((segment) => (segment.startsWith('[') ? `:${segment.slice(1, -1)}` : segment))
      .join('/')
  )
}

/**
 * A matcher is an Express `app.use` prefix: it covers itself and everything beneath.
 * Its own params (`/store/carts/:id/start-checkout`) match any single segment.
 */
function matcherCovers(matcher: string, path: string): boolean {
  const m = matcher.split('/').filter(Boolean)
  const p = path.split('/').filter(Boolean)
  if (p.length < m.length) return false
  return m.every((segment, i) => segment.startsWith(':') || segment === p[i])
}

const allRoutes = routeFiles(API_ROOT)

/**
 * A route consumes Clerk identity iff it imports the helpers that read it. Matched on
 * the IMPORT, not on a name that could appear in a comment — and `resolveSeller` is
 * deliberately included because it is `clerk-auth`'s own Clerk-keyed seller lookup.
 *
 * BOTH quote styles, and an optional extension. The first version of this matched
 * single quotes only, which is the repo's prevailing style — so it passed, and a route
 * written `from "../_utils/clerk-auth"` would have dropped straight out of the
 * population while the guard stayed green. A detector that only recognises the style
 * that happens to be in use today is a guard with an expiry date on it.
 */
export const CLERK_AUTH_IMPORT = /from\s+['"][^'"]*_utils\/clerk-auth(\.[cm]?[jt]s)?['"]/

const clerkRoutes = allRoutes.filter((file) => CLERK_AUTH_IMPORT.test(read(file)))

describe('Clerk verification — middleware coverage', () => {
  it('scans a real route tree (a guard that scans nothing is not a guard)', () => {
    expect(allRoutes.length).toBeGreaterThan(80)
    // The route that exposed the hole must be in the derived set, or the derivation
    // itself is broken and everything below is vacuous.
    expect(clerkRoutes.map(rel)).toContain(
      'src/api/store/sellers/me/stripe-connect/route.ts'.split('/').join(sep),
    )
    expect(clerkRoutes.length).toBeGreaterThan(30)
  })

  it.each(clerkRoutes.map((file) => [urlPath(file), file]))(
    '%s is covered by a verification matcher',
    (path) => {
      const covered = CLERK_VERIFIED_MATCHERS.filter((m) => matcherCovers(m, path as string))
      // Reported as the path itself, so a failure names the unguarded route rather
      // than printing `false`.
      expect({ path, covered }).toEqual({ path, covered: expect.arrayContaining([expect.any(String)]) })
    },
  )

  it('every matcher still covers something — a dead prefix is a silent gap', () => {
    // A matcher left behind after its routes move reads as coverage and provides none.
    for (const matcher of CLERK_VERIFIED_MATCHERS) {
      const covered = clerkRoutes.filter((file) => matcherCovers(matcher, urlPath(file)))
      expect({ matcher, routes: covered.length }).toEqual({ matcher, routes: expect.any(Number) })
      expect(covered.length).toBeGreaterThan(0)
    }
  })

  it('no route reads an unverified JWT payload of its own', () => {
    // The hole was a base64 decode of the payload segment. Ban re-growing one anywhere
    // in the API tree — including a helper that a route might import later.
    const apiFiles = readdirSync(API_ROOT, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts') && !entry.includes(`__tests__${sep}`))
      .map((entry) => join(API_ROOT, entry))
    expect(apiFiles.length).toBeGreaterThan(100)

    for (const file of apiFiles) {
      const source = read(file)
      const decodesJwtPayload =
        /split\(\s*'\.'\s*\)/.test(source) && /base64url|from\(\s*parts\[1\]/.test(source)
      expect({ file: rel(file), decodesJwtPayload }).toEqual({ file: rel(file), decodesJwtPayload: false })
    }
  })

  it('the detector recognises every way a route can import clerk-auth', () => {
    // The detector IS the population. If it misses a spelling, every assertion above
    // it silently stops covering that route while still reporting green.
    for (const source of [
      "import { extractClerkUserId } from '../../_utils/clerk-auth'",
      'import { extractClerkUserId } from "../../_utils/clerk-auth"',
      'import { resolveSeller } from "../../../_utils/clerk-auth.js"',
      "export { extractClerkEmail } from '../_utils/clerk-auth'",
    ]) {
      expect({ source, detected: CLERK_AUTH_IMPORT.test(source) }).toEqual({ source, detected: true })
    }
    // …and does not fire on a mere mention, which would drag unrelated routes in and
    // train someone to loosen it. Always allow the negation of what you ban.
    for (const source of [
      '// see _utils/clerk-auth for how identity is established',
      "import { somethingElse } from '../../_utils/clerk-auth-helpers'",
    ]) {
      expect({ source, detected: CLERK_AUTH_IMPORT.test(source) }).toEqual({ source, detected: false })
    }
  })

  it('clerk-auth reads only what the middleware verified', () => {
    const source = read(join(API_ROOT, 'store/_utils/clerk-auth.ts'))
    expect(source).toMatch(/readVerifiedClerkIdentity/)
    // The negation of what we ban is explicitly allowed: the file may still mention
    // the header in prose. What it may not do is read it for identity.
    expect(source).not.toMatch(/headers\s*\[\s*['"]authorization/i)
  })
})
