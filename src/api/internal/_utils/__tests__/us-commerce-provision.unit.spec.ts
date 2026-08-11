import {
  planUsCommercePack,
  reconcileUsCommercePackLocked,
  US_RESOURCE_NAMES,
  type UsCommerceSnapshot,
} from '../us-commerce-provision'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const empty = (): UsCommerceSnapshot => ({
  mx_inventory: { configured_stock_location_id: 'sloc_mx', proven_stock_location_ids: ['sloc_mx'] },
  store: { id: 'store_1', supported_currencies: [{ currency_code: 'mxn', is_default: true }] },
  regions: [], tax_regions: [], sales_channels: [], api_keys: [], stock_locations: [], fulfillment_sets: [],
  manual_provider_exists: true,
  manual_provider_location_ids: [],
})

const complete = (): UsCommerceSnapshot => ({
  mx_inventory: { configured_stock_location_id: 'sloc_mx', proven_stock_location_ids: ['sloc_mx'] },
  store: { id: 'store_1', supported_currencies: [
    { currency_code: 'mxn', is_default: true }, { currency_code: 'usd', is_default: false },
  ] },
  regions: [{
    id: 'reg_us', name: US_RESOURCE_NAMES.region, currency_code: 'usd', country_codes: ['us'],
    payment_provider_ids: ['pp_system_default'],
  }],
  tax_regions: [{ id: 'txreg_us', country_code: 'us', provider_id: 'tp_system', parent_id: null }],
  sales_channels: [
    { id: 'sc_market', name: US_RESOURCE_NAMES.marketplace_channel, stock_location_ids: ['sloc_us'], publishable_api_key_ids: [] },
    { id: 'sc_operating', name: US_RESOURCE_NAMES.operating_channel, stock_location_ids: ['sloc_us'], publishable_api_key_ids: ['apk_us'] },
  ],
  api_keys: [{
    id: 'apk_us', title: US_RESOURCE_NAMES.api_key, token: 'pk_123456789abcdefghijkl',
    sales_channel_ids: ['sc_operating'], dangling_sales_channel_links: 0,
  }],
  stock_locations: [{
    id: 'sloc_us', name: US_RESOURCE_NAMES.stock_location, country_code: 'us',
    fulfillment_provider_ids: ['manual_manual'], fulfillment_set_ids: ['fset_us'],
    sales_channel_ids: ['sc_market', 'sc_operating'],
  }],
  fulfillment_sets: [{
    id: 'fset_us', name: US_RESOURCE_NAMES.fulfillment_set, type: 'shipping', stock_location_id: 'sloc_us',
    service_zones: [{ id: 'serzo_us', name: US_RESOURCE_NAMES.service_zone, country_codes: ['us'], geo_zone_types: ['country'] }],
  }],
  manual_provider_exists: true,
  manual_provider_location_ids: ['sloc_us'],
})

describe('US commerce provision route shell', () => {
  const source = readFileSync(join(process.cwd(), 'src/api/internal/us-commerce-provision/route.ts'), 'utf8')

  it('keeps GET read-only, POST explicit, authenticated, and re-surveys after apply', () => {
    expect(source).toMatch(/export async function GET/)
    expect(source).toMatch(/return respond\(req, res\)/)
    expect(source).toMatch(/body\.dry_run === false/)
    expect(source.match(/internalSecretOk\(req\)/g)).toHaveLength(2)
    expect(source).toMatch(/Modules\.LOCKING/)
    expect(source).toMatch(/reconcileUsCommercePackLocked/)
    expect(source).toContain("relations: ['supported_currencies']")
    expect(source).toContain("relations: ['address']")
    expect(source).not.toMatch(/list(?:Regions|SalesChannels|StockLocations)[\s\S]{0,120}\.catch\(\(\) => \[\]\)/)
  })

  it('reports apply failures as partial/unknown, never as a confident no-write result', () => {
    expect(source).toMatch(/applied: applyStarted \? 'unknown' : false/)
    expect(source).toMatch(/partial_or_unknown/)
  })
})

describe('US commerce resource-pack planner', () => {
  it('plans the complete pack without changing MX store-default semantics', () => {
    const plan = planUsCommercePack(empty())
    expect(plan.blocked_by).toEqual([])
    expect(plan.actions).toEqual([
      'add_store_usd', 'create_region', 'create_tax_region',
      'create_marketplace_channel', 'create_operating_channel', 'create_publishable_key',
      'link_key_operating_channel', 'create_stock_location', 'link_manual_provider',
      'link_location_marketplace_channel', 'link_location_operating_channel',
      'create_fulfillment_set', 'link_location_fulfillment_set',
    ])
  })

  it('blocks when the Store survey cannot prove exactly one default currency', () => {
    const snapshot = empty()
    snapshot.store!.supported_currencies = [{ currency_code: 'mxn', is_default: false }]
    const plan = planUsCommercePack(snapshot)
    expect(plan.blocked_by.join(' ')).toMatch(/exactly one default currency/)
    expect(plan.actions).not.toContain('add_store_usd')
  })

  it('blocks an existing USD default instead of silently changing the market default', () => {
    const snapshot = complete()
    snapshot.store!.supported_currencies = [
      { currency_code: 'mxn', is_default: false },
      { currency_code: 'usd', is_default: true },
    ]
    expect(planUsCommercePack(snapshot).blocked_by.join(' ')).toMatch(/USD must be supported but non-default/)
  })

  it('is a verified no-op on a complete second run', () => {
    const plan = planUsCommercePack(complete())
    expect(plan).toMatchObject({ ready: true, blocked_by: [], actions: [] })
    expect(plan.resources).toEqual({
      region_id: 'reg_us', marketplace_channel_id: 'sc_market', operating_channel_id: 'sc_operating',
      api_key_id: 'apk_us', publishable_key_token_prefix: 'pk_123456789', stock_location_id: 'sloc_us',
      fulfillment_set_id: 'fset_us', service_zone_id: 'serzo_us',
      mx_stock_location_id_for_env: 'sloc_mx',
    })
    expect(JSON.stringify(plan)).not.toContain('pk_123456789abcdefghijkl')
  })

  it('serializes concurrent applies and re-surveys so only the first call writes', async () => {
    let snapshot = empty()
    let tail = Promise.resolve()
    let applies = 0
    const withLock = async <T>(operation: () => Promise<T>): Promise<T> => {
      const previous = tail
      let release!: () => void
      tail = new Promise<void>((resolve) => { release = resolve })
      await previous
      try { return await operation() } finally { release() }
    }
    const run = () => reconcileUsCommercePackLocked({
      withLock,
      survey: async () => snapshot,
      apply: async () => { applies++; snapshot = complete() },
    })
    const [first, second] = await Promise.all([run(), run()])
    expect(applies).toBe(1)
    expect([first.state, second.state]).toEqual(['applied', 'noop'])
  })

  it('does not survey or write when the distributed lock refuses the claim', async () => {
    let surveys = 0
    let applies = 0
    await expect(reconcileUsCommercePackLocked({
      withLock: async () => { throw new Error('lock unavailable') },
      survey: async () => { surveys++; return empty() },
      apply: async () => { applies++ },
    })).rejects.toThrow('lock unavailable')
    expect({ surveys, applies }).toEqual({ surveys: 0, applies: 0 })
  })

  it('blocks duplicate or foreign-owned identities before any create action can run', () => {
    const snapshot = empty()
    snapshot.regions = [
      { id: 'a', name: US_RESOURCE_NAMES.region, currency_code: 'usd', country_codes: ['us'], payment_provider_ids: ['pp_system_default'] },
      { id: 'b', name: 'USA duplicate', currency_code: 'usd', country_codes: ['us'], payment_provider_ids: ['pp_system_default'] },
    ]
    const plan = planUsCommercePack(snapshot)
    expect(plan.blocked_by.join(' ')).toMatch(/Multiple Region/)
    expect(plan.ready).toBe(false)
  })

  it('refuses a key linked to marketplace or multiple channels', () => {
    const snapshot = empty()
    snapshot.sales_channels = [
      {
        id: 'sc_market', name: US_RESOURCE_NAMES.marketplace_channel,
        stock_location_ids: [], publishable_api_key_ids: ['apk_us'],
      },
      {
        id: 'sc_operating', name: US_RESOURCE_NAMES.operating_channel,
        stock_location_ids: [], publishable_api_key_ids: ['apk_us'],
      },
    ]
    snapshot.api_keys = [{
      id: 'apk_us', title: US_RESOURCE_NAMES.api_key, token: 'pk_us',
      sales_channel_ids: ['sc_market', 'sc_operating'], dangling_sales_channel_links: 0,
    }]
    expect(planUsCommercePack(snapshot).blocked_by.join(' ')).toMatch(/link only to operating/)
  })

  it('verifies reverse link directions instead of trusting one expanded side', () => {
    const snapshot = empty()
    snapshot.sales_channels = [
      {
        id: 'sc_market', name: US_RESOURCE_NAMES.marketplace_channel,
        stock_location_ids: ['sloc_us'], publishable_api_key_ids: [],
      },
      {
        id: 'sc_operating', name: US_RESOURCE_NAMES.operating_channel,
        stock_location_ids: ['sloc_us'], publishable_api_key_ids: [],
      },
    ]
    snapshot.api_keys = [{
      id: 'apk_us', title: US_RESOURCE_NAMES.api_key, token: 'pk_us',
      sales_channel_ids: ['sc_operating'], dangling_sales_channel_links: 0,
    }]
    snapshot.stock_locations = [{
      id: 'sloc_us', name: US_RESOURCE_NAMES.stock_location, country_code: 'us',
      fulfillment_provider_ids: ['manual_manual'], fulfillment_set_ids: ['fset_us'], sales_channel_ids: [],
    }]
    snapshot.fulfillment_sets = [{
      id: 'fset_us', name: US_RESOURCE_NAMES.fulfillment_set, type: 'shipping', stock_location_id: null,
      service_zones: [{
        id: 'serzo_us', name: US_RESOURCE_NAMES.service_zone,
        country_codes: ['us'], geo_zone_types: ['country'],
      }],
    }]
    const blocked = planUsCommercePack(snapshot).blocked_by.join(' ')
    expect(blocked).toMatch(/key\/channel reverse link/)
    expect(blocked).toMatch(/marketplace\/location reverse link/)
    expect(blocked).toMatch(/operating\/location reverse link/)
    expect(blocked).toMatch(/manual-provider\/location reverse link/)
    expect(blocked).toMatch(/fulfillment-set\/location reverse link/)
  })

  it('blocks incomplete provider, zone, and dangling-link topology from verified=true', () => {
    const snapshot = empty()
    snapshot.manual_provider_exists = false
    snapshot.api_keys = [{
      id: 'apk_us', title: US_RESOURCE_NAMES.api_key, token: 'pk_us',
      sales_channel_ids: [], dangling_sales_channel_links: 1,
    }]
    snapshot.fulfillment_sets = [{
      id: 'fset_us', name: US_RESOURCE_NAMES.fulfillment_set, type: 'pickup', stock_location_id: null,
      service_zones: [
        { id: 'zone_us', name: US_RESOURCE_NAMES.service_zone, country_codes: ['us'], geo_zone_types: ['country'] },
        { id: 'zone_extra', name: 'Canada', country_codes: ['ca'], geo_zone_types: ['country'] },
      ],
    }]
    const blocked = planUsCommercePack(snapshot).blocked_by.join(' ')
    expect(blocked).toMatch(/dangling Sales Channel link/)
    expect(blocked).toMatch(/manual_manual fulfillment provider is unavailable/)
    expect(blocked).toMatch(/not type shipping/)
    expect(blocked).toMatch(/exactly the US service zone/)
  })

  it('surfaces the provable MX location and blocks until MEDUSA_STOCK_LOCATION_ID is configured', () => {
    const snapshot = empty()
    snapshot.mx_inventory.configured_stock_location_id = null
    snapshot.mx_inventory.proven_stock_location_ids = ['sloc_existing_mx']
    const plan = planUsCommercePack(snapshot)
    expect(plan.blocked_by.join(' ')).toMatch(/MEDUSA_STOCK_LOCATION_ID=sloc_existing_mx/)
    expect(plan.resources.mx_stock_location_id_for_env).toBe('sloc_existing_mx')
  })

  it.each([
    { provider_id: 'tp_foreign', parent_id: null },
    { provider_id: 'tp_system', parent_id: 'txreg_parent' },
  ])('blocks Tax Region identity drift %#', (drift) => {
    const snapshot = complete()
    snapshot.tax_regions = [{ id: 'txreg_us', country_code: 'us', ...drift }]
    expect(planUsCommercePack(snapshot).blocked_by.join(' ')).toMatch(/top-level tp_system/)
  })
})
