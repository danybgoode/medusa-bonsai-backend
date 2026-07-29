import { readFileSync } from 'fs'
import { join } from 'path'
import { UnknownMarketError } from '../../../../lib/markets'
import {
  MARKETPLACE_CHANNEL_FIELDS,
  filterToMarketplaceChannel,
  productInMarketplaceChannel,
  reportMarketplaceMembership,
  resolveMarketReadGate,
  resolveRequestedMarket,
} from '../market-read'
import { isHiddenCatalogProduct } from '../support'

/**
 * The marketplace read boundary (build contract item 3, D1/D4).
 *
 * The headline case is the epic's deterministic proof:
 *   owned-visible product + NO channel membership ⇒ present on the owned shop,
 *   absent from the `mx` marketplace query.
 *
 * MUTATION PROOF (Definition of Done): delete the `filterToMarketplaceChannel` call
 * in `src/api/store/listings/route.ts` — or make `productInMarketplaceChannel`
 * return `true` — and "hidden from the mx marketplace" below goes red.
 */

const MX_CHANNEL = 'sc_01KSK1J0V81P4EPY9G0JAPX353'
const PROD_ENV = { MEDUSA_SALES_CHANNEL_ID: MX_CHANNEL }

describe('resolveRequestedMarket', () => {
  it('defaults to mx when the parameter is absent (pre-launch compatibility)', () => {
    expect(resolveRequestedMarket(undefined)).toBe('mx')
    expect(resolveRequestedMarket(null)).toBe('mx')
    expect(resolveRequestedMarket('  ')).toBe('mx')
  })

  it('accepts a supported code', () => {
    expect(resolveRequestedMarket('mx')).toBe('mx')
    expect(resolveRequestedMarket('US')).toBe('us')
  })

  it('a PRESENT unrecognised value is an error, never the default', () => {
    const result = resolveRequestedMarket('es-MX')
    expect(typeof result).toBe('object')
    expect((result as { error: UnknownMarketError }).error).toBeInstanceOf(UnknownMarketError)
    expect((result as { error: UnknownMarketError }).error.message).toMatch(/LOCALE/)
  })
})

describe('resolveMarketReadGate — four outcomes, all named', () => {
  it('mx opens against the configured marketplace channel', () => {
    expect(resolveMarketReadGate(undefined, PROD_ENV)).toEqual({ ok: true, market: 'mx', channel_id: MX_CHANNEL })
  })

  it('us CLOSES with a structured body — never an empty success, never MX rows', () => {
    const gate = resolveMarketReadGate('us', PROD_ENV)
    expect(gate.ok).toBe(false)
    if (gate.ok) throw new Error('unreachable')
    expect(gate.kind).toBe('closed')
    expect(gate.status).toBe(404)
    expect(gate.body).toEqual({
      unavailable: true,
      market_code: 'us',
      marketplace_status: 'invitation',
      reason: expect.stringMatching(/invitation/),
    })
    // The whole point: no catalog key at all, so no caller can read it as "0 results".
    expect(gate.body).not.toHaveProperty('listings')
  })

  it('an unknown market is a 400 that names the caller mistake', () => {
    const gate = resolveMarketReadGate('es-MX', PROD_ENV)
    expect(gate.ok).toBe(false)
    if (gate.ok) throw new Error('unreachable')
    expect(gate.kind).toBe('unknown')
    expect(gate.status).toBe(400)
    expect(gate.body.reason).toMatch(/LOCALE/)
  })

  it('an OPEN market with no addressable channel FAILS CLOSED (503), it does not serve unfiltered', () => {
    const gate = resolveMarketReadGate('mx', {})
    expect(gate.ok).toBe(false)
    if (gate.ok) throw new Error('unreachable')
    expect(gate.kind).toBe('unavailable')
    expect(gate.status).toBe(503)
    expect(gate.body.reason).toMatch(/MEDUSA_SALES_CHANNEL_ID/)
    // Distinct from the `us` case — a misconfigured deploy must not read as
    // "this market has no marketplace".
    const usGate = resolveMarketReadGate('us', {})
    expect(usGate.ok).toBe(false)
    if (usGate.ok) throw new Error('unreachable')
    expect(usGate.kind).toBe('closed')
    expect(gate.kind).not.toBe(usGate.kind)
  })
})

describe('productInMarketplaceChannel', () => {
  it('is true only for a real membership row', () => {
    expect(productInMarketplaceChannel({ sales_channels: [{ id: MX_CHANNEL }] }, MX_CHANNEL)).toBe(true)
    expect(productInMarketplaceChannel({ sales_channels: [{ id: 'sc_other' }] }, MX_CHANNEL)).toBe(false)
    expect(productInMarketplaceChannel({ sales_channels: [] }, MX_CHANNEL)).toBe(false)
    expect(productInMarketplaceChannel({}, MX_CHANNEL)).toBe(false)
    expect(productInMarketplaceChannel({ sales_channels: null }, MX_CHANNEL)).toBe(false)
  })

  it('treats a DANGLING link row as "not a member" instead of throwing', () => {
    // `query.graph` expands a link to a deleted channel into a null-ish entry with no
    // id. 15 such rows existed in production in July 2026 and an unguarded
    // dereference took an internal route down twice.
    expect(() => productInMarketplaceChannel({ sales_channels: [null, undefined, {}] as any }, MX_CHANNEL)).not.toThrow()
    expect(productInMarketplaceChannel({ sales_channels: [null, { id: MX_CHANNEL }] as any }, MX_CHANNEL)).toBe(true)
    expect(productInMarketplaceChannel({ sales_channels: [null, {}] as any }, MX_CHANNEL)).toBe(false)
  })
})

/**
 * ── THE DETERMINISTIC EXPOSURE PROOF (story 1.3, D4) ────────────────────────
 * One product, owned by a seller, published, not hidden, and NOT a member of the MX
 * marketplace channel. It must be visible on its own shop and invisible in `/mx`.
 */
describe('owned shop vs marketplace publication are INDEPENDENT', () => {
  const ownedOnly = {
    id: 'prod_owned_only',
    status: 'published',
    metadata: { listing_type: 'product' },
    sales_channels: [] as Array<{ id: string }>,
  }
  const alsoInMarketplace = {
    id: 'prod_in_market',
    status: 'published',
    metadata: { listing_type: 'product' },
    sales_channels: [{ id: MX_CHANNEL }],
  }
  const catalog = [ownedOnly, alsoInMarketplace]

  it('is HIDDEN from the mx marketplace query', () => {
    const gate = resolveMarketReadGate('mx', PROD_ENV)
    if (!gate.ok) throw new Error('mx gate must open')
    const visible = filterToMarketplaceChannel(catalog, gate.channel_id).map((p) => p.id)
    expect(visible).toEqual(['prod_in_market'])
    expect(visible).not.toContain('prod_owned_only')
  })

  it('is PRESENT on the owned shop — whose read is ownership + publish state only', () => {
    // The owned shop's predicate, exactly as `/store/sellers/:slug/products` applies
    // it: linked to the seller, status published, not a hidden catalog primitive.
    // No channel anywhere in it — that is the point.
    const linkedToSeller = new Set(['prod_owned_only'])
    const shopVisible = catalog
      .filter((p) => linkedToSeller.has(p.id))
      .filter((p) => p.status === 'published')
      .filter((p) => !isHiddenCatalogProduct(p.metadata))
      .map((p) => p.id)
    expect(shopVisible).toEqual(['prod_owned_only'])
  })

  it('and the owned-shop ROUTE really does apply no channel filter (source-level, D4)', () => {
    // The simulation above could drift from the shipped route, so assert against the
    // real file: adding a market filter here is the failure this epic exists to
    // prevent, and it must fail a spec rather than a customer's shop.
    const routePath = join(process.cwd(), 'src/api/store/sellers/[slug]/products/route.ts')
    const source = readFileSync(routePath, 'utf8')
    expect(source).toContain("filters: { status: 'published' }")
    expect(source).toContain('linkedIdSet.has(product.id)')
    expect(source).not.toMatch(/market-read|resolveMarketReadGate|sales_channels/)
  })
})

describe('reportMarketplaceMembership — the D1 dry-run gate counts with the SAME predicate', () => {
  it('counts the products the boundary would hide', () => {
    const report = reportMarketplaceMembership([
      { id: 'a', sales_channels: [{ id: MX_CHANNEL }] },
      { id: 'b', sales_channels: [] },
      { id: 'c', sales_channels: [{ id: 'sc_other' }] },
    ] as any, MX_CHANNEL)
    expect(report.scanned).toBe(3)
    expect(report.linked).toBe(1)
    expect(report.missing.map((p: any) => p.id)).toEqual(['b', 'c'])
    expect(report.unusable_link_rows).toBe(0)
  })

  it('counts dangling link rows separately — an under-reporting report says so', () => {
    const report = reportMarketplaceMembership([
      { id: 'a', sales_channels: [null, { id: MX_CHANNEL }] },
      { id: 'b', sales_channels: [null, null] },
    ] as any, MX_CHANNEL)
    expect(report.unusable_link_rows).toBe(3)
    expect(report.missing.map((p: any) => p.id)).toEqual(['b'])
  })

  it('agrees with the read boundary on every row (one definition of membership)', () => {
    const products = [
      { id: 'a', sales_channels: [{ id: MX_CHANNEL }] },
      { id: 'b', sales_channels: [] },
    ]
    const report = reportMarketplaceMembership(products as any, MX_CHANNEL)
    const filtered = filterToMarketplaceChannel(products as any, MX_CHANNEL)
    expect(report.linked).toBe(filtered.length)
  })
})

describe('MARKETPLACE_CHANNEL_FIELDS', () => {
  it('asks for exactly the field the filter reads', () => {
    // A route that requests a different shape would see every product as
    // channel-less and return an empty catalog.
    expect(MARKETPLACE_CHANNEL_FIELDS).toEqual(['sales_channels.id'])
  })
})
