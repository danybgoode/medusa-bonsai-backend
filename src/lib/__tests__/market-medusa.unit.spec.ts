import { UnknownMarketError } from '../markets'
import {
  protectedSalesChannelIds,
  registryMarketplaceChannelIds,
  registryRegionIds,
  resolveMarketplaceChannelForMarket,
  resolveMarketplaceChannelId,
  resolveRegionForMarket,
  resolveRegionIdForMarket,
} from '../market-medusa'

/**
 * The market → Medusa id seam (build contract item 1, D0/D2).
 *
 * Every case runs against an INJECTED env object — no `process.env`, no container,
 * no database — which is the point of the seam: the branch that decides whether a
 * market can address a Sales Channel is testable without one existing.
 */

// The production values, from D0 (re-derived live 2026-07-28).
const PROD_ENV = {
  MEDUSA_SALES_CHANNEL_ID: 'sc_01KSK1J0V81P4EPY9G0JAPX353',
  MEDUSA_MXN_REGION_ID: 'reg_01KSK1HZAWN5ZCSPZ74ER97HD9',
}

describe('resolveMarketplaceChannelId', () => {
  it('mx resolves to MEDUSA_SALES_CHANNEL_ID', () => {
    expect(resolveMarketplaceChannelId('mx', PROD_ENV)).toBe('sc_01KSK1J0V81P4EPY9G0JAPX353')
  })

  it('us resolves to null — there is no US Sales Channel in any environment (D0)', () => {
    expect(resolveMarketplaceChannelId('us', PROD_ENV)).toBeNull()
  })

  it('an unknown market THROWS rather than resolving to the Mexico channel', () => {
    expect(() => resolveMarketplaceChannelId('ca', PROD_ENV)).toThrow(UnknownMarketError)
    expect(() => resolveMarketplaceChannelId('es-MX', PROD_ENV)).toThrow(/LOCALE/)
    expect(() => resolveMarketplaceChannelId(undefined, PROD_ENV)).toThrow(UnknownMarketError)
  })

  it('a whitespace-only env value counts as unset, not as a channel id', () => {
    expect(resolveMarketplaceChannelId('mx', { MEDUSA_SALES_CHANNEL_ID: '   ' })).toBeNull()
  })
})

describe('resolveMarketplaceChannelForMarket — three states, never two', () => {
  it('resolved carries the id', () => {
    expect(resolveMarketplaceChannelForMarket('mx', PROD_ENV)).toEqual({
      status: 'resolved', market: 'mx', kind: 'marketplace_channel', id: PROD_ENV.MEDUSA_SALES_CHANNEL_ID,
    })
  })

  it('us is no_resource — structurally absent, NOT a configuration gap', () => {
    const resolution = resolveMarketplaceChannelForMarket('us', PROD_ENV)
    expect(resolution.status).toBe('no_resource')
    if (resolution.status === 'no_resource') expect(resolution.reason).toMatch(/no Medusa marketplace_channel/)
  })

  it('mx with the env var missing is UNCONFIGURED — a different fact from us', () => {
    const resolution = resolveMarketplaceChannelForMarket('mx', {})
    expect(resolution.status).toBe('unconfigured')
    if (resolution.status === 'unconfigured') {
      expect(resolution.env_var).toBe('MEDUSA_SALES_CHANNEL_ID')
      expect(resolution.reason).toMatch(/fail closed/)
    }
    // Both produce `null` from the convenience helper — which is exactly why the
    // helper is not enough on its own for a read boundary.
    expect(resolveMarketplaceChannelId('mx', {})).toBeNull()
    expect(resolveMarketplaceChannelId('us', {})).toBeNull()
    expect(resolveMarketplaceChannelForMarket('mx', {}).status)
      .not.toBe(resolveMarketplaceChannelForMarket('us', {}).status)
  })
})

describe('resolveRegionIdForMarket', () => {
  it('mx resolves to MEDUSA_MXN_REGION_ID', () => {
    expect(resolveRegionIdForMarket('mx', PROD_ENV)).toBe('reg_01KSK1HZAWN5ZCSPZ74ER97HD9')
  })

  it('us resolves to null — production holds exactly one Region, Mexico (D0)', () => {
    expect(resolveRegionIdForMarket('us', PROD_ENV)).toBeNull()
    expect(resolveRegionForMarket('us', PROD_ENV).status).toBe('no_resource')
  })

  it('unknown throws', () => {
    expect(() => resolveRegionIdForMarket('br', PROD_ENV)).toThrow(UnknownMarketError)
  })

  it('never hands the MX region to another market', () => {
    expect(resolveRegionIdForMarket('us', PROD_ENV)).not.toBe(PROD_ENV.MEDUSA_MXN_REGION_ID)
  })
})

describe('the protected-resource allow-lists are DERIVED from the registry', () => {
  it('registry ids contain the configured MX ids and nothing else', () => {
    expect(registryMarketplaceChannelIds(PROD_ENV)).toEqual([PROD_ENV.MEDUSA_SALES_CHANNEL_ID])
    expect(registryRegionIds(PROD_ENV)).toEqual([PROD_ENV.MEDUSA_MXN_REGION_ID])
  })

  it('an empty environment yields an EMPTY list — it never invents an id', () => {
    expect(registryMarketplaceChannelIds({})).toEqual([])
    expect(registryRegionIds({})).toEqual([])
  })

  it('protectedSalesChannelIds also protects the store default, deduped (D6)', () => {
    expect(protectedSalesChannelIds(PROD_ENV, 'sc_01KRVSGTDJ50SW7TF83M192ZNQ')).toEqual([
      'sc_01KSK1J0V81P4EPY9G0JAPX353',
      'sc_01KRVSGTDJ50SW7TF83M192ZNQ',
    ])
    expect(protectedSalesChannelIds(PROD_ENV, PROD_ENV.MEDUSA_SALES_CHANNEL_ID))
      .toEqual([PROD_ENV.MEDUSA_SALES_CHANNEL_ID])
    expect(protectedSalesChannelIds(PROD_ENV, null)).toEqual([PROD_ENV.MEDUSA_SALES_CHANNEL_ID])
  })
})
