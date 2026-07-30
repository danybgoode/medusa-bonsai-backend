import { readFileSync, readdirSync } from 'fs'
import { join, relative, sep } from 'path'

/**
 * THE POPULATION GUARD for the marketplace read boundary.
 *
 * Guard the population, not the door you found. The build contract names
 * `/store/listings` and `/store/listings/[id]`; enumerating those two by hand would
 * pass forever while a THIRD public catalog route shipped unguarded next to them —
 * which is exactly how seven sibling write primitives once stayed open while one was
 * fixed (LEARNINGS).
 *
 * So this spec GLOBS the route tree and derives the population mechanically:
 *   · every public catalog GET under `src/api/store/listings/` must resolve the
 *     market gate before it answers;
 *   · no seller-scoped or owned-shop read may resolve it (D4).
 *
 * cwd is the package root under jest, same convention as `ci-workflow.unit.spec.ts`.
 */

const API_ROOT = join(process.cwd(), 'src/api')
const STORE_API = join(API_ROOT, 'store')

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith(`${sep}route.ts`) || entry === 'route.ts')
    .map((entry) => join(dir, entry))
}

const allRoutes = routeFiles(STORE_API)
const read = (file: string) => readFileSync(file, 'utf8')
const rel = (file: string) => relative(process.cwd(), file)

describe('market boundary — population guard', () => {
  it('finds the store route tree at all (a guard that scans nothing is not a guard)', () => {
    // A green run over an empty population reads as a passing gate and is worse than
    // no gate. Pin a floor well below the current count (~40 store routes).
    expect(allRoutes.length).toBeGreaterThan(20)
    expect(allRoutes.some((f) => rel(f).endsWith('src/api/store/listings/route.ts'))).toBe(true)
  })

  /**
   * A public catalog read = a route under `listings/` that exports a GET and reads
   * the `product` entity. `[id]/view/route.ts` is excluded by construction: it is a
   * POST that increments a counter, not a catalog read — no product data leaves it.
   */
  const catalogReads = allRoutes.filter((file) => {
    if (!rel(file).includes(`${sep}listings${sep}`) && !rel(file).endsWith(`listings${sep}route.ts`)) return false
    const source = read(file)
    return /export\s+async\s+function\s+GET/.test(source) && /entity:\s*'product'/.test(source)
  })

  it('enumerates every public catalog GET under listings/', () => {
    const names = catalogReads.map(rel).sort()
    // Stated explicitly so ADDING a catalog route is a visible, reviewed change
    // rather than a silent one — the list below and the assertion after it must both
    // be updated, and the second one is the real gate.
    expect(names).toEqual([
      'src/api/store/listings/[id]/price-grid/route.ts',
      'src/api/store/listings/[id]/route.ts',
      'src/api/store/listings/route.ts',
    ].map((p) => p.split('/').join(sep)))
  })

  it.each(catalogReads.map((file) => [rel(file), file]))(
    '%s resolves the market gate and fails closed on a closed gate',
    (_name, file) => {
      const source = read(file as string)
      expect(source).toMatch(/resolveMarketReadGate\(/)
      // The gate is only a gate if its negative branch returns.
      expect(source).toMatch(/if\s*\(!gate\.ok\)/)
      expect(source).toMatch(/gate\.status/)
      // …and the route must actually request the field the filter reads.
      expect(source).toMatch(/MARKETPLACE_CHANNEL_FIELDS/)
      // …and use the channel for something.
      expect(source).toMatch(/gate\.channel_id/)
    },
  )

  /**
   * Story 1.2: "new shop creation requires or deliberately defaults an approved
   * market at the entry seam". Enumerated mechanically for the same reason as
   * above — there are two seller-create seams today (self-serve and the supply
   * importer) and a third would otherwise ship un-stamped, quietly re-growing the
   * backfill population this epic exists to close.
   *
   * `src/scripts/panfleto-s1-create-platform-seller.ts` is deliberately out of
   * scope: it is a one-off `medusa exec` script for a single already-created
   * platform seller, not a request-time entry seam.
   */
  const sellerCreateSeams = routeFiles(API_ROOT).filter((file) => /createSellers\(/.test(read(file)))

  it('finds both seller-create entry seams', () => {
    expect(sellerCreateSeams.map(rel).sort()).toEqual([
      'src/api/internal/sellers/route.ts',
      'src/api/store/sellers/me/route.ts',
    ].map((p) => p.split('/').join(sep)))
  })

  it.each(sellerCreateSeams.map((file) => [rel(file), file]))(
    '%s stamps operating_market through the one writer, and never from a locale',
    (_name, file) => {
      const source = read(file as string)
      expect(source).toMatch(/setSellerOperatingMarket\(/)
      // Written into the row, not merely computed.
      expect(source).toMatch(/metadata:\s*marketMetadata/)
      // No country inferred from the browser's language. Matched on the HEADER
      // READ, not on the string: banning the word would redden a comment that
      // explains the rule, and a guard that rejects correct code is worse than one
      // that misses a rare fault (LEARNINGS) — it teaches people to delete it.
      expect(source).not.toMatch(/headers\s*\[\s*['"]accept-language/i)
    },
  )

  it('no seller-scoped or owned-shop read applies the marketplace channel filter (D4)', () => {
    const sellerRoutes = allRoutes.filter((file) => rel(file).includes(`${sep}sellers${sep}`))
    expect(sellerRoutes.length).toBeGreaterThan(5)
    for (const file of sellerRoutes) {
      const source = read(file)
      expect({ file: rel(file), matches: /resolveMarketReadGate|filterToMarketplaceChannel|productInMarketplaceChannel/.test(source) })
        .toEqual({ file: rel(file), matches: false })
    }
  })

  it('owned-shop detail and price-grid reads enforce seller ownership + publish state', () => {
    const ownedReads = [
      'src/api/store/sellers/[slug]/products/[id]/route.ts',
      'src/api/store/sellers/[slug]/products/[id]/price-grid/route.ts',
    ].map((path) => join(process.cwd(), ...path.split('/')))
    for (const file of ownedReads) {
      const source = read(file)
      expect(source).toMatch(/resolveSellerProductIds\(/)
      expect(source).toMatch(/owned\.has\(id\)/)
      expect(source).toMatch(/status:\s*'published'/)
      expect(source).not.toMatch(/MARKETPLACE_CHANNEL_FIELDS|sales_channels/)
    }
  })

  it('the generic seller metadata PATCH reserves operating_market', () => {
    const source = read(join(STORE_API, 'sellers/me/route.ts'))
    expect(source).toMatch(/hasOwnProperty\.call\(body\.metadata,\s*SELLER_OPERATING_MARKET_KEY\)/)
    expect(source).toMatch(/status\(422\)/)
  })

  it('public seller reads use the sanitized projection', () => {
    const publicReads = [
      'src/api/store/sellers/route.ts',
      'src/api/store/sellers/[slug]/route.ts',
      'src/api/store/sellers/[slug]/products/route.ts',
    ].map((path) => join(process.cwd(), ...path.split('/')))
    for (const file of publicReads) {
      expect(read(file)).toMatch(/toSellerShape/)
    }
  })
})
