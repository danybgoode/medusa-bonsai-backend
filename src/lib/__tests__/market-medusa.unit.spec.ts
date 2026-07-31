import { UnknownMarketError } from '../markets'
import {
  protectedSalesChannelIds,
  registryMarketplaceChannelIds,
  registryOperatingChannelIds,
  registryRegionIds,
  resolveMarketplaceChannelForMarket,
  resolveMarketplaceChannelId,
  resolveOperatingChannelForMarket,
  resolveOperatingChannelId,
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

// The operating channel is a DIFFERENT env var from the marketplace channel and from
// production's real id (owned-shop-operating-channel epic, S1.2) — kept separate
// here so a spec cannot pass by accidentally reading the marketplace channel's id.
const PROD_ENV_WITH_OPERATING = {
  ...PROD_ENV,
  MEDUSA_MX_OPERATING_CHANNEL_ID: 'sc_operating_mx_placeholder',
}

describe('resolveOperatingChannelId', () => {
  it('mx resolves to MEDUSA_MX_OPERATING_CHANNEL_ID', () => {
    expect(resolveOperatingChannelId('mx', PROD_ENV_WITH_OPERATING)).toBe('sc_operating_mx_placeholder')
  })

  it('us resolves to null — there is no US operating channel in any environment', () => {
    expect(resolveOperatingChannelId('us', PROD_ENV_WITH_OPERATING)).toBeNull()
  })

  it('an unknown market THROWS rather than resolving to the Mexico operating channel', () => {
    expect(() => resolveOperatingChannelId('ca', PROD_ENV_WITH_OPERATING)).toThrow(UnknownMarketError)
  })

  it('a whitespace-only env value counts as unset, not as a channel id', () => {
    expect(resolveOperatingChannelId('mx', { MEDUSA_MX_OPERATING_CHANNEL_ID: '   ' })).toBeNull()
  })

  it('mx is unconfigured (not merely null) while MEDUSA_SALES_CHANNEL_ID IS set — the ' +
    'two channels never share a fallback', () => {
    // The marketplace channel resolves fine; the operating channel must still read
    // as its OWN unconfigured state rather than borrowing the marketplace id.
    expect(resolveMarketplaceChannelId('mx', PROD_ENV)).toBe(PROD_ENV.MEDUSA_SALES_CHANNEL_ID)
    expect(resolveOperatingChannelId('mx', PROD_ENV)).toBeNull()
    expect(resolveOperatingChannelForMarket('mx', PROD_ENV).status).toBe('unconfigured')
  })
})

describe('resolveOperatingChannelForMarket — three states, never two', () => {
  it('resolved carries the id', () => {
    expect(resolveOperatingChannelForMarket('mx', PROD_ENV_WITH_OPERATING)).toEqual({
      status: 'resolved',
      market: 'mx',
      kind: 'operating_channel',
      id: PROD_ENV_WITH_OPERATING.MEDUSA_MX_OPERATING_CHANNEL_ID,
    })
  })

  it('us is no_resource — structural, exactly like the marketplace channel', () => {
    const resolution = resolveOperatingChannelForMarket('us', PROD_ENV_WITH_OPERATING)
    expect(resolution.status).toBe('no_resource')
    if (resolution.status === 'no_resource') expect(resolution.reason).toMatch(/no Medusa operating_channel/)
  })

  it('mx with the env var missing is UNCONFIGURED, and never falls back to the ' +
    'marketplace channel id', () => {
    const resolution = resolveOperatingChannelForMarket('mx', PROD_ENV)
    expect(resolution.status).toBe('unconfigured')
    if (resolution.status === 'unconfigured') {
      expect(resolution.env_var).toBe('MEDUSA_MX_OPERATING_CHANNEL_ID')
      expect(resolution.reason).toMatch(/fail closed/)
    }
    // The convenience helper collapses unconfigured/no_resource to `null` — proving
    // it is NEVER the marketplace channel's id, which is the one wrong answer a
    // fallback could produce.
    expect(resolveOperatingChannelId('mx', PROD_ENV)).not.toBe(PROD_ENV.MEDUSA_SALES_CHANNEL_ID)
    expect(resolveOperatingChannelId('mx', PROD_ENV)).toBeNull()
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
    expect(registryOperatingChannelIds({})).toEqual([])
  })

  it('protectedSalesChannelIds also protects the store default, deduped (D6)', () => {
    // Unchanged from before the operating channel existed: PROD_ENV here carries no
    // MEDUSA_MX_OPERATING_CHANNEL_ID, so registryOperatingChannelIds(PROD_ENV) is
    // empty and contributes nothing — this is the exact env shape production is in
    // the moment this sprint's allow-list entry deploys, BEFORE the channel exists
    // (epic README, D10 step 1).
    expect(protectedSalesChannelIds(PROD_ENV, 'sc_01KRVSGTDJ50SW7TF83M192ZNQ')).toEqual([
      'sc_01KSK1J0V81P4EPY9G0JAPX353',
      'sc_01KRVSGTDJ50SW7TF83M192ZNQ',
    ])
    expect(protectedSalesChannelIds(PROD_ENV, PROD_ENV.MEDUSA_SALES_CHANNEL_ID))
      .toEqual([PROD_ENV.MEDUSA_SALES_CHANNEL_ID])
    expect(protectedSalesChannelIds(PROD_ENV, null)).toEqual([PROD_ENV.MEDUSA_SALES_CHANNEL_ID])
  })

  it('registryOperatingChannelIds contains the configured MX operating id and ' +
    'nothing else — owned-shop-operating-channel epic, S1.2', () => {
    expect(registryOperatingChannelIds(PROD_ENV_WITH_OPERATING))
      .toEqual([PROD_ENV_WITH_OPERATING.MEDUSA_MX_OPERATING_CHANNEL_ID])
  })

  it('protectedSalesChannelIds protects the operating channel the moment it is ' +
    'configured — D10: protected BEFORE it exists in production', () => {
    const protectedIds = protectedSalesChannelIds(
      PROD_ENV_WITH_OPERATING,
      'sc_01KRVSGTDJ50SW7TF83M192ZNQ',
    )
    expect(protectedIds).toContain(PROD_ENV_WITH_OPERATING.MEDUSA_MX_OPERATING_CHANNEL_ID)
    expect(protectedIds).toContain(PROD_ENV_WITH_OPERATING.MEDUSA_SALES_CHANNEL_ID)
    expect(protectedIds).toContain('sc_01KRVSGTDJ50SW7TF83M192ZNQ')
  })
})
