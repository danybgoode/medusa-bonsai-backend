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

const STORE_API = join(process.cwd(), 'src/api/store')

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

  it('no seller-scoped or owned-shop read applies the marketplace channel filter (D4)', () => {
    const sellerRoutes = allRoutes.filter((file) => rel(file).includes(`${sep}sellers${sep}`))
    expect(sellerRoutes.length).toBeGreaterThan(5)
    for (const file of sellerRoutes) {
      const source = read(file)
      expect({ file: rel(file), matches: /resolveMarketReadGate|filterToMarketplaceChannel|productInMarketplaceChannel/.test(source) })
        .toEqual({ file: rel(file), matches: false })
    }
  })
})
