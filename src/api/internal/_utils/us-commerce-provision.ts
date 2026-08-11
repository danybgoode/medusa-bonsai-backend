/** Pure US resource-pack ownership, diff and verification contract. */

export const US_RESOURCE_NAMES = Object.freeze({
  region: 'United States',
  marketplace_channel: 'Miyagi Markets US',
  operating_channel: 'Miyagi Operating US',
  api_key: 'Miyagi US Publishable Key',
  stock_location: 'Miyagi United States',
  fulfillment_set: 'Miyagi United States',
  service_zone: 'United States',
})

export interface UsCommerceSnapshot {
  mx_inventory: { configured_stock_location_id: string | null; proven_stock_location_ids: string[] }
  store: null | { id: string; supported_currencies: Array<{ currency_code: string; is_default?: boolean }> }
  regions: Array<{
    id: string
    name: string
    currency_code: string
    country_codes: string[]
    payment_provider_ids: string[]
  }>
  tax_regions: Array<{ id: string; country_code: string; provider_id: string | null; parent_id: string | null }>
  sales_channels: Array<{
    id: string
    name: string
    stock_location_ids: string[]
    publishable_api_key_ids: string[]
  }>
  api_keys: Array<{
    id: string
    title: string
    token: string | null
    sales_channel_ids: string[]
    dangling_sales_channel_links: number
  }>
  stock_locations: Array<{
    id: string
    name: string
    country_code: string | null
    fulfillment_provider_ids: string[]
    fulfillment_set_ids: string[]
    sales_channel_ids: string[]
  }>
  fulfillment_sets: Array<{
    id: string
    name: string
    type: string
    stock_location_id: string | null
    service_zones: Array<{
      id: string
      name: string
      country_codes: string[]
      geo_zone_types: string[]
    }>
  }>
  manual_provider_exists: boolean
  manual_provider_location_ids: string[]
}

export type UsCommerceAction =
  | 'add_store_usd'
  | 'create_region'
  | 'create_tax_region'
  | 'create_marketplace_channel'
  | 'create_operating_channel'
  | 'create_publishable_key'
  | 'create_stock_location'
  | 'link_manual_provider'
  | 'link_location_marketplace_channel'
  | 'link_location_operating_channel'
  | 'link_key_operating_channel'
  | 'create_fulfillment_set'
  | 'link_location_fulfillment_set'

export interface UsCommercePlan {
  ready: boolean
  blocked_by: string[]
  actions: UsCommerceAction[]
  resources: {
    region_id: string | null
    marketplace_channel_id: string | null
    operating_channel_id: string | null
    api_key_id: string | null
    publishable_key_token_prefix: string | null
    stock_location_id: string | null
    fulfillment_set_id: string | null
    service_zone_id: string | null
    mx_stock_location_id_for_env: string | null
  }
}

export type UsCommerceApplyOutcome =
  | { state: 'blocked'; before: UsCommerceSnapshot; plan: UsCommercePlan }
  | { state: 'noop'; before: UsCommerceSnapshot; plan: UsCommercePlan }
  | { state: 'applied'; before: UsCommerceSnapshot; plan: UsCommercePlan; after: UsCommerceSnapshot; verified: UsCommercePlan }

export interface StoreOwnershipCandidate {
  id: string
  name?: string | null
  default_sales_channel_id?: string | null
  supported_currencies?: Array<{ currency_code: string; is_default?: boolean }>
}

export const PLATFORM_STORE_NAME = 'Miyagi Sánchez'

/**
 * Medusa can contain stale Store rows because its historical seed created one
 * on every run. Prefer the configured MX marketplace edge. Older production
 * predates that edge on Store itself, so the explicit platform identity written
 * by setup-mexico (canonical name + MXN default) is the only admitted secondary
 * identity. Row order and age are never selectors.
 */
export function selectConfiguredMarketplaceStore<T extends StoreOwnershipCandidate>(
  stores: readonly T[],
  configuredMarketplaceChannelId: string | null | undefined,
): { store: T | null; error: string | null } {
  const channelId = configuredMarketplaceChannelId?.trim()
  if (!channelId) {
    return { store: null, error: 'MEDUSA_SALES_CHANNEL_ID is required to identify the owned Store.' }
  }
  const channelMatches = stores.filter((store) => store.default_sales_channel_id === channelId)
  if (channelMatches.length === 1) return { store: channelMatches[0], error: null }
  if (channelMatches.length > 1) {
    return {
      store: null,
      error: `Expected at most one Store owned by configured MX marketplace channel ${channelId}; found ${channelMatches.length} among ${stores.length}.`,
    }
  }

  const namedMatches = stores.filter((store) => {
    const defaults = (store.supported_currencies ?? []).filter((currency) => currency.is_default)
    return store.name === PLATFORM_STORE_NAME
      && defaults.length === 1
      && defaults[0].currency_code.toLowerCase() === 'mxn'
  })
  if (namedMatches.length !== 1) {
    return {
      store: null,
      error: `No Store uses configured MX marketplace channel ${channelId}; expected exactly one ${PLATFORM_STORE_NAME} Store with MXN default, found ${namedMatches.length} among ${stores.length}.`,
    }
  }
  return { store: namedMatches[0], error: null }
}

/**
 * Serialize the entire read-decide-write-verify sequence. Names are operational
 * identities, not database uniqueness constraints, so surveying outside the
 * distributed lock would let two instances both observe "missing" and create.
 */
export async function reconcileUsCommercePackLocked(deps: {
  withLock<T>(operation: () => Promise<T>): Promise<T>
  survey(): Promise<UsCommerceSnapshot>
  apply(before: UsCommerceSnapshot, actions: readonly UsCommerceAction[]): Promise<void>
}): Promise<UsCommerceApplyOutcome> {
  return deps.withLock(async () => {
    const before = await deps.survey()
    const plan = planUsCommercePack(before)
    if (plan.blocked_by.length > 0) return { state: 'blocked', before, plan }
    if (plan.actions.length === 0) return { state: 'noop', before, plan }
    await deps.apply(before, plan.actions)
    const after = await deps.survey()
    return { state: 'applied', before, plan, after, verified: planUsCommercePack(after) }
  })
}

const oneOwned = <T>(rows: T[], label: string, blocked: string[]): T | null => {
  if (rows.length > 1) blocked.push(`Multiple ${label} resources match the US ownership identity.`)
  return rows.length === 1 ? rows[0] : null
}

export function planUsCommercePack(s: UsCommerceSnapshot): UsCommercePlan {
  const blocked: string[] = []
  const actions: UsCommerceAction[] = []
  const mxCandidates = [...new Set(s.mx_inventory.proven_stock_location_ids)]
  if (!s.mx_inventory.configured_stock_location_id) {
    blocked.push(mxCandidates.length === 1
      ? `Set MEDUSA_STOCK_LOCATION_ID=${mxCandidates[0]} before deploying market-scoped inventory writers.`
      : `MEDUSA_STOCK_LOCATION_ID is unset and the configured MX channel/manual-provider graph yielded ${mxCandidates.length} candidates; repair MX ownership before deploy.`)
  } else if (mxCandidates.length !== 1 || mxCandidates[0] !== s.mx_inventory.configured_stock_location_id) {
    blocked.push('Configured MEDUSA_STOCK_LOCATION_ID does not match the single MX channel/manual-provider-owned location.')
  }
  if (!s.store) blocked.push('No Store row was returned; seed the environment first.')
  else {
    const defaultCurrencies = s.store.supported_currencies.filter((c) => c.is_default)
    const usd = s.store.supported_currencies.find((c) => lower(c.currency_code) === 'usd')
    if (defaultCurrencies.length !== 1) {
      blocked.push(`Store must expose exactly one default currency before USD can be reconciled; found ${defaultCurrencies.length}.`)
    } else if (usd?.is_default) {
      blocked.push('USD must be supported but non-default; the existing market default must remain unchanged.')
    } else if (!usd) actions.push('add_store_usd')
  }

  const namedRegions = s.regions.filter((r) => r.name === US_RESOURCE_NAMES.region)
  const countryRegions = s.regions.filter((r) => r.country_codes.map(lower).includes('us'))
  const region = oneOwned([...new Map([...namedRegions, ...countryRegions].map((r) => [r.id, r])).values()], 'Region', blocked)
  const allowedUsPaymentProviders = new Set(['pp_system_default', 'pp_stripe-connect_stripe-connect'])
  if (region && (lower(region.currency_code) !== 'usd'
    || !exactly(region.country_codes.map(lower), ['us'])
    || !region.payment_provider_ids.includes('pp_system_default')
    || region.payment_provider_ids.some((id) => !allowedUsPaymentProviders.has(id)))) {
    blocked.push(`Owned US Region ${region.id} must be USD, country us, include pp_system_default, and contain no provider outside the locked US set.`)
  } else if (!region) actions.push('create_region')

  const tax = oneOwned(s.tax_regions.filter((r) => lower(r.country_code) === 'us'), 'Tax Region', blocked)
  if (tax && (tax.provider_id !== 'tp_system' || tax.parent_id !== null)) {
    blocked.push(`Owned US Tax Region ${tax.id} must be a top-level tp_system country region.`)
  } else if (!tax) actions.push('create_tax_region')

  const marketplace = oneOwned(s.sales_channels.filter((c) => c.name === US_RESOURCE_NAMES.marketplace_channel), 'marketplace Sales Channel', blocked)
  const operating = oneOwned(s.sales_channels.filter((c) => c.name === US_RESOURCE_NAMES.operating_channel), 'operating Sales Channel', blocked)
  if (!marketplace) actions.push('create_marketplace_channel')
  if (!operating) actions.push('create_operating_channel')

  const key = oneOwned(s.api_keys.filter((k) => k.title === US_RESOURCE_NAMES.api_key), 'publishable API key', blocked)
  if (!key) actions.push('create_publishable_key', 'link_key_operating_channel')
  if (key && !key.token?.trim()) blocked.push(`US publishable key ${key.id} did not return its pk_… token.`)
  if (key && key.dangling_sales_channel_links > 0) {
    blocked.push(`US publishable key ${key.id} has ${key.dangling_sales_channel_links} dangling Sales Channel link row(s).`)
  }
  if (key && operating) {
    const links = [...new Set(key.sales_channel_ids)]
    if (links.length === 0) actions.push('link_key_operating_channel')
    else if (links.length !== 1 || links[0] !== operating.id) {
      blocked.push(`US publishable key ${key.id} must link only to operating channel ${operating.id}; found [${links.join(', ')}].`)
    }
    const reverse = operating.publishable_api_key_ids.filter((id) => id === key.id)
    if (links.length === 1 && reverse.length !== 1) {
      blocked.push(`US key/channel reverse link is inconsistent for ${key.id}↔${operating.id}.`)
    }
  } else if (key && !operating) {
    if (key.sales_channel_ids.length > 0) blocked.push(`US key ${key.id} has links before the owned operating channel exists.`)
    else actions.push('link_key_operating_channel')
  }

  const location = oneOwned(s.stock_locations.filter((l) => l.name === US_RESOURCE_NAMES.stock_location), 'stock location', blocked)
  if (location && lower(location.country_code) !== 'us') blocked.push(`Owned US stock location ${location.id} is not in country us.`)
  else if (!location) actions.push('create_stock_location')
  if (!s.manual_provider_exists) blocked.push('The manual_manual fulfillment provider is unavailable; refusing to create a partially usable US pack.')
  else if (!location || !location.fulfillment_provider_ids.includes('manual_manual')) actions.push('link_manual_provider')
  if (location && location.fulfillment_provider_ids.includes('manual_manual')
    && !s.manual_provider_location_ids.includes(location.id)) {
    blocked.push(`US manual-provider/location reverse link is inconsistent for manual_manual↔${location.id}.`)
  }
  if (!location || !marketplace || !marketplace.stock_location_ids.includes(location.id)) actions.push('link_location_marketplace_channel')
  if (!location || !operating || !operating.stock_location_ids.includes(location.id)) actions.push('link_location_operating_channel')
  if (location && marketplace && marketplace.stock_location_ids.includes(location.id)
    && !location.sales_channel_ids.includes(marketplace.id)) {
    blocked.push(`US marketplace/location reverse link is inconsistent for ${marketplace.id}↔${location.id}.`)
  }
  if (location && operating && operating.stock_location_ids.includes(location.id)
    && !location.sales_channel_ids.includes(operating.id)) {
    blocked.push(`US operating/location reverse link is inconsistent for ${operating.id}↔${location.id}.`)
  }

  const set = oneOwned(s.fulfillment_sets.filter((f) => f.name === US_RESOURCE_NAMES.fulfillment_set), 'fulfillment set', blocked)
  if (set && lower(set.type) !== 'shipping') blocked.push(`Owned US fulfillment set ${set.id} is not type shipping.`)
  const zones = set?.service_zones.filter((z) => z.name === US_RESOURCE_NAMES.service_zone) ?? []
  const zone = oneOwned(zones, 'service zone', blocked)
  if (set && (set.service_zones.length !== 1 || !zone
    || !exactly(zone.country_codes.map(lower), ['us'])
    || !exactly(zone.geo_zone_types.map(lower), ['country']))) {
    blocked.push(`Owned US fulfillment set ${set.id} does not contain exactly the US service zone.`)
  } else if (!set) actions.push('create_fulfillment_set')
  if (!location || !set || !location.fulfillment_set_ids.includes(set.id)) actions.push('link_location_fulfillment_set')
  if (location && set && location.fulfillment_set_ids.includes(set.id) && set.stock_location_id !== location.id) {
    blocked.push(`US fulfillment-set/location reverse link is inconsistent for ${set.id}↔${location.id}.`)
  }

  const uniqueActions = [...new Set(actions)]
  return {
    ready: blocked.length === 0 && uniqueActions.length === 0,
    blocked_by: blocked,
    actions: uniqueActions,
    resources: {
      region_id: region?.id ?? null,
      marketplace_channel_id: marketplace?.id ?? null,
      operating_channel_id: operating?.id ?? null,
      api_key_id: key?.id ?? null,
      publishable_key_token_prefix: key?.token ? key.token.slice(0, 12) : null,
      stock_location_id: location?.id ?? null,
      fulfillment_set_id: set?.id ?? null,
      service_zone_id: zone?.id ?? null,
      mx_stock_location_id_for_env: mxCandidates.length === 1 ? mxCandidates[0] : null,
    },
  }
}

function lower(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function exactly(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((value) => actual.includes(value))
}
