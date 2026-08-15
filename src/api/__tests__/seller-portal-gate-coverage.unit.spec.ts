import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import middlewareConfig from '../middlewares'

/**
 * THE SUBTREE GUARD for the seller-portal write gate (tenant-lifecycle-admin · D2c).
 *
 * ── WHY THIS SPEC EXISTS ──────────────────────────────────────────────────────
 * A cross-family review round claimed the gate covered only the exact path
 * `/store/sellers/me` and not its children, which would have meant a paused seller
 * could still `POST /store/sellers/me/products`. That claim was WRONG — verified
 * against the installed framework, `@medusajs/framework/dist/http/router.js`:
 *
 *     if (!route.methods) { … app.use(route.matcher, wrapHandler(handler)); return }
 *     …
 *     methods.forEach((method) => app[method.toLowerCase()](route.matcher, handler))
 *
 * A middleware entry WITHOUT a `methods` key registers via `app.use(path, …)`, and
 * Express `app.use` matches the path and everything beneath it. An entry WITH
 * `methods` registers via `app.get`/`app.post`, which matches the exact path only.
 *
 * So the behaviour is correct — but it is correct BECAUSE of an absent key, which is
 * exactly the kind of load-bearing absence that a well-meaning edit deletes. Someone
 * narrowing this entry to `methods: ['POST','PUT','PATCH','DELETE']` would look like
 * they were tightening it and would in fact silently drop every child route out of
 * the gate. That is what this spec pins.
 *
 * The same reasoning covers the Clerk verification matchers, whose entire security
 * value rests on the identical mechanism.
 */
const entries = (middlewareConfig as { routes: Array<Record<string, unknown>> }).routes

function entriesFor(matcher: string): Array<Record<string, unknown>> {
  return entries.filter((entry) => entry.matcher === matcher)
}

describe('the portal write gate covers the /store/sellers/me SUBTREE', () => {
  it('is registered on the subtree root', () => {
    const gate = entriesFor('/store/sellers/me').filter((entry) =>
      (entry.middlewares as Array<{ name?: string }>).some((m) => m?.name === 'gateSellerPortalWrites'),
    )
    expect(gate).toHaveLength(1)
  })

  it('declares NO `methods` — this is what makes it a prefix rather than one exact route', () => {
    // `app.use(path)` matches descendants; `app.post(path)` does not. The absence of
    // this key IS the subtree coverage. Narrowing the entry to explicit methods would
    // look like a tightening and would silently drop /store/sellers/me/products,
    // /orders, /coupons and every other child out of the gate.
    for (const entry of entriesFor('/store/sellers/me')) {
      expect(entry.methods).toBeUndefined()
      expect(entry.method).toBeUndefined()
    }
  })

  it('the framework really does treat a methods-less entry as app.use', () => {
    // Pinned against the INSTALLED framework rather than asserted from memory: this
    // is the fact the whole gate rests on, and a major-version bump that changed it
    // would otherwise be invisible until a paused seller sold something.
    // Resolved, not hardcoded: npm workspaces HOIST the framework to the monorepo
    // root, so `<pkg>/node_modules/...` does not exist here. `require.resolve` on the
    // package.json is refused by its `exports` map, so resolve the http entry point
    // and walk to its sibling — which also guarantees we read the file that is
    // actually running rather than some other copy.
    const httpEntry = require.resolve('@medusajs/framework/http')
    const router = readFileSync(join(dirname(httpEntry), 'router.js'), 'utf8')
    expect(router).toContain('if (!route.methods)')
    expect(router).toMatch(/app.*\.use\(route\.matcher/)
  })

  it('the child routes a paused seller must not reach exist under that prefix', () => {
    // A guard over a prefix nothing lives under would pass forever while protecting
    // nothing. Name the real children so this stays anchored to the actual API.
    const { readdirSync } = require('fs') as typeof import('fs')
    const children = readdirSync(join(process.cwd(), 'src/api/store/sellers/me'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    expect(children).toEqual(expect.arrayContaining(['products', 'orders', 'coupons']))
  })
})

describe('the Clerk verification matchers rest on the same mechanism', () => {
  it('none of them declare methods either', () => {
    for (const entry of entries) {
      const middlewares = entry.middlewares as Array<{ name?: string }>
      if (middlewares.some((m) => m?.name === 'verifyClerkIdentity')) {
        expect(entry.methods).toBeUndefined()
      }
    }
  })
})
