/**
 * Authenticated, in-VPC US commerce resource provisioning.
 * GET is fully read-only. POST defaults to dry-run and applies only with
 * `{ "dry_run": false }`. Every refusal is evaluated from a complete survey
 * before the first workflow runs; apply re-surveys and verifies its claims.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import {
  createApiKeysWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createStockLocationsWorkflow,
  createTaxRegionsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
} from '@medusajs/medusa/core-flows'
import { internalSecretOk } from '../../../lib/internal-auth'
import {
  planUsCommercePack,
  reconcileUsCommercePackLocked,
  US_RESOURCE_NAMES,
  type UsCommercePlan,
  type UsCommerceSnapshot,
} from '../_utils/us-commerce-provision'

const MAX_SURVEY_ROWS = 500

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!internalSecretOk(req)) return res.status(401).json({ message: 'Unauthorized' })
  return respond(req, res)
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!internalSecretOk(req)) return res.status(401).json({ message: 'Unauthorized' })
  const body = (req.body ?? {}) as { dry_run?: boolean }
  return body.dry_run === false ? respondApply(req, res) : respond(req, res)
}

async function respond(req: MedusaRequest, res: MedusaResponse) {
  let before: UsCommerceSnapshot
  try {
    before = await survey(req.scope)
  } catch (e) {
    return res.status(503).json({
      unavailable: true,
      dry_run: true,
      applied: false,
      message: `US commerce survey unavailable: ${message(e)}`,
    })
  }

  const plan = planUsCommercePack(before)
  if (plan.blocked_by.length > 0) {
    return res.status(409).json({ dry_run: true, applied: false, ...plan })
  }
  return res.status(plan.blocked_by.length > 0 ? 409 : 200).json({ dry_run: true, applied: false, ...plan })
}

async function respondApply(req: MedusaRequest, res: MedusaResponse) {
  const locking: any = req.scope.resolve(Modules.LOCKING)
  let applyStarted = false
  let outcome: Awaited<ReturnType<typeof reconcileUsCommercePackLocked>>
  try {
    outcome = await reconcileUsCommercePackLocked({
      withLock: (operation) => locking.execute(
        'us-commerce-resource-pack', operation, { timeout: 5 },
      ),
      survey: () => survey(req.scope),
      apply: async (before, actions) => {
        applyStarted = true
        await applyPlan(req.scope, before, actions)
      },
    })
  } catch (e) {
    return res.status(applyStarted ? 500 : 503).json({
      unavailable: !applyStarted,
      dry_run: false,
      // Workflows are not one transaction. Once apply begins, failure means the
      // database is partial/unknown until a fresh GET surveys it.
      applied: applyStarted ? 'unknown' : false,
      state: applyStarted ? 'partial_or_unknown' : 'unavailable',
      message: `${applyStarted ? 'US commerce apply or verification failed' : 'US commerce lock/survey unavailable'}; re-run GET to reconcile actual state: ${message(e)}`,
    })
  }
  if (outcome.state === 'blocked') {
    return res.status(409).json({ dry_run: false, applied: false, ...outcome.plan })
  }
  if (outcome.state === 'noop') {
    return res.json({
      dry_run: false,
      applied: false,
      verified: true,
      ...outcome.plan,
      // Provisioning workflows may succeed even when their first verification
      // cannot load a relation. A later authenticated POST must still hand the
      // operator the existing token; otherwise the new publishable key is
      // irretrievable without direct database access.
      configuration_required: configurationFor(outcome.plan, outcome.before),
    })
  }
  const verified = outcome.verified
  return res.status(verified.ready ? 200 : 500).json({
    dry_run: false,
    applied: true,
    verified: verified.ready,
    actions_applied: outcome.plan.actions,
    ...verified,
    configuration_required: configurationFor(verified, outcome.after),
  })
}

function configurationFor(plan: UsCommercePlan, snapshot: UsCommerceSnapshot) {
  if (!plan.ready) return null
  const publishableToken = snapshot.api_keys.find((key) => key.id === plan.resources.api_key_id)?.token ?? null
  return {
    MEDUSA_STOCK_LOCATION_ID: plan.resources.mx_stock_location_id_for_env,
    MEDUSA_US_REGION_ID: plan.resources.region_id,
    MEDUSA_US_MARKETPLACE_CHANNEL_ID: plan.resources.marketplace_channel_id,
    MEDUSA_US_OPERATING_CHANNEL_ID: plan.resources.operating_channel_id,
    MEDUSA_US_STOCK_LOCATION_ID: plan.resources.stock_location_id,
    // Publishable tokens are browser credentials by design. Return the full token
    // only inside this authenticated POST response so the operator can complete
    // the one-run env handoff; logs/reports keep only the prefix.
    MEDUSA_US_PUBLISHABLE_KEY: publishableToken,
    api_key_id: plan.resources.api_key_id,
    publishable_key_token_prefix: plan.resources.publishable_key_token_prefix,
  }
}

async function survey(scope: MedusaRequest['scope']): Promise<UsCommerceSnapshot> {
  const storeService: any = scope.resolve(Modules.STORE)
  const regionService: any = scope.resolve(Modules.REGION)
  const taxService: any = scope.resolve(Modules.TAX)
  const salesChannelService: any = scope.resolve(Modules.SALES_CHANNEL)
  const stockService: any = scope.resolve(Modules.STOCK_LOCATION)
  const fulfillmentService: any = scope.resolve(Modules.FULFILLMENT)
  const query: any = scope.resolve(ContainerRegistrationKeys.QUERY)

  const [stores, rawRegions, rawTaxes, rawChannels, rawLocations, rawSets, keyGraph, providerGraph] = await Promise.all([
    // `supported_currencies` is a relation. Selecting only the relation name
    // returned currency codes without `is_default` in staging, which made an
    // otherwise safe USD append submit zero default currencies. Load it explicitly.
    storeService.listStores({}, {
      select: ['id'], relations: ['supported_currencies'], take: 2,
    }),
    regionService.listRegions({}, { select: ['id', 'name', 'currency_code'], relations: ['countries'], take: MAX_SURVEY_ROWS + 1 }),
    taxService.listTaxRegions({}, { select: ['id', 'country_code', 'provider_id', 'parent_id'], take: MAX_SURVEY_ROWS + 1 }),
    salesChannelService.listSalesChannels({}, { select: ['id', 'name'], take: MAX_SURVEY_ROWS + 1 }),
    // `address` follows the same Medusa relation-loading rule as Store
    // currencies. Staging proved that selecting it without `relations` returns
    // an owned location with no country and makes a correct pack look corrupt.
    stockService.listStockLocations({}, {
      select: ['id', 'name'], relations: ['address'], take: MAX_SURVEY_ROWS + 1,
    }),
    fulfillmentService.listFulfillmentSets({}, { select: ['id', 'name', 'type'], relations: ['service_zones', 'service_zones.geo_zones'], take: MAX_SURVEY_ROWS + 1 }),
    query.graph({
      entity: 'api_key', fields: ['id', 'title', 'token', 'sales_channels.*'],
      filters: { type: 'publishable' }, pagination: { take: MAX_SURVEY_ROWS + 1, skip: 0 },
    }),
    query.graph({
      entity: 'fulfillment_provider', fields: ['id', 'locations.id'], filters: { id: 'manual_manual' },
    }),
  ])
  for (const [name, rows] of Object.entries({ rawRegions, rawTaxes, rawChannels, rawLocations, rawSets, keys: keyGraph.data })) {
    if (!Array.isArray(rows)) throw new Error(`${name} survey did not return an array`)
    if (rows.length > MAX_SURVEY_ROWS) throw new Error(`${name} survey exceeded ${MAX_SURVEY_ROWS} rows; refusing a truncated graph`)
  }
  if (!Array.isArray(stores) || stores.length !== 1) throw new Error(`expected exactly one Store, found ${Array.isArray(stores) ? stores.length : 'unavailable'}`)
  if (!Array.isArray(providerGraph.data)) throw new Error('manual provider survey did not return an array')

  const regionGraph = await Promise.all(rawRegions.map(async (r: any) => {
    const { data } = await query.graph({
      entity: 'region', fields: ['id', 'payment_providers.id'], filters: { id: r.id },
    })
    return { ...r, payment_providers: data?.[0]?.payment_providers ?? [] }
  }))

  const channelGraph = await Promise.all(rawChannels.map(async (c: any) => {
    const { data } = await query.graph({
      entity: 'sales_channel',
      fields: ['id', 'stock_locations.id', 'publishable_api_keys.id'],
      filters: { id: c.id },
    })
    return { ...c, ...(data?.[0] ?? {}) }
  }))
  const locationGraph = await Promise.all(rawLocations.map(async (l: any) => {
    const { data } = await query.graph({
      entity: 'stock_location',
      fields: ['id', 'sales_channels.id', 'fulfillment_providers.id', 'fulfillment_sets.id'],
      filters: { id: l.id },
    })
    return { ...l, ...(data?.[0] ?? {}) }
  }))
  const fulfillmentSetGraph = await Promise.all(rawSets.map(async (f: any) => {
    const { data } = await query.graph({
      entity: 'fulfillment_set', fields: ['id', 'location.id'], filters: { id: f.id },
    })
    return { ...f, ...(data?.[0] ?? {}) }
  }))

  return {
    mx_inventory: {
      configured_stock_location_id: process.env.MEDUSA_STOCK_LOCATION_ID?.trim() || null,
      proven_stock_location_ids: locationGraph
        .filter((location: any) => {
          const mxChannelIds = [process.env.MEDUSA_SALES_CHANNEL_ID, process.env.MEDUSA_MX_OPERATING_CHANNEL_ID]
            .map((id) => id?.trim()).filter((id): id is string => !!id)
          const linkedChannels = (location.sales_channels ?? []).map((channel: any) => channel?.id).filter(Boolean)
          const linkedProviders = (location.fulfillment_providers ?? []).map((provider: any) => provider?.id).filter(Boolean)
          return mxChannelIds.length === 2
            && mxChannelIds.every((id) => linkedChannels.includes(id))
            && linkedProviders.includes('manual_manual')
        })
        .map((location: any) => location.id),
    },
    store: {
      id: stores[0].id,
      supported_currencies: (stores[0].supported_currencies ?? []).map((c: any) => ({
        currency_code: String(c.currency_code), is_default: !!c.is_default,
      })),
    },
    regions: regionGraph.map((r: any) => ({
      id: r.id, name: r.name, currency_code: r.currency_code,
      country_codes: (r.countries ?? []).map((c: any) => String(c.iso_2 ?? c.country_code ?? c.code ?? '')).filter(Boolean),
      payment_provider_ids: (r.payment_providers ?? []).map((p: any) => p?.id).filter(Boolean),
    })),
    tax_regions: rawTaxes.map((r: any) => ({
      id: r.id, country_code: r.country_code,
      provider_id: r.provider_id ?? null, parent_id: r.parent_id ?? null,
    })),
    sales_channels: channelGraph.map((c: any) => ({
      id: c.id, name: c.name,
      stock_location_ids: (c.stock_locations ?? []).map((l: any) => l?.id).filter(Boolean),
      publishable_api_key_ids: (c.publishable_api_keys ?? []).map((k: any) => k?.id).filter(Boolean),
    })),
    api_keys: (keyGraph.data ?? []).map((k: any) => ({
      id: k.id, title: k.title, token: k.token ?? null,
      sales_channel_ids: (k.sales_channels ?? []).map((c: any) => c?.id).filter(Boolean),
      dangling_sales_channel_links: (k.sales_channels ?? []).filter((c: any) => !c?.id).length,
    })),
    stock_locations: locationGraph.map((l: any) => ({
      id: l.id, name: l.name, country_code: l.address?.country_code ?? null,
      fulfillment_provider_ids: (l.fulfillment_providers ?? []).map((p: any) => p?.id).filter(Boolean),
      fulfillment_set_ids: (l.fulfillment_sets ?? []).map((f: any) => f?.id).filter(Boolean),
      sales_channel_ids: (l.sales_channels ?? []).map((c: any) => c?.id).filter(Boolean),
    })),
    fulfillment_sets: fulfillmentSetGraph.map((f: any) => ({
      id: f.id, name: f.name, type: f.type,
      stock_location_id: f.location?.id ?? null,
      service_zones: (f.service_zones ?? []).map((z: any) => ({
        id: z.id, name: z.name,
        country_codes: (z.geo_zones ?? []).map((g: any) => g?.country_code).filter(Boolean),
        geo_zone_types: (z.geo_zones ?? []).map((g: any) => g?.type).filter(Boolean),
      })),
    })),
    manual_provider_exists: providerGraph.data.length === 1 && providerGraph.data[0]?.id === 'manual_manual',
    manual_provider_location_ids: (providerGraph.data?.[0]?.locations ?? [])
      .map((location: any) => location?.id).filter(Boolean),
  }
}

async function applyPlan(scope: MedusaRequest['scope'], before: UsCommerceSnapshot, actions: readonly string[]) {
  const has = (action: string) => actions.includes(action)
  const storeService: any = scope.resolve(Modules.STORE)
  const link: any = scope.resolve(ContainerRegistrationKeys.LINK)
  const fulfillmentService: any = scope.resolve(Modules.FULFILLMENT)

  if (has('add_store_usd')) {
    const store = before.store!
    await storeService.updateStores(store.id, {
      supported_currencies: [
        ...store.supported_currencies.map((c) => ({ ...c })),
        { currency_code: 'usd', is_default: false },
      ],
    })
  }

  let regionId = planUsCommercePack(before).resources.region_id
  if (has('create_region')) {
    const { result } = await createRegionsWorkflow(scope).run({ input: { regions: [{
      // S1 is browse/manual-only. S4 adds the direct-charge Stripe provider after
      // its connected-account context has test-mode evidence.
      name: US_RESOURCE_NAMES.region, currency_code: 'usd', countries: ['us'],
      payment_providers: ['pp_system_default'],
    }] } })
    regionId = result[0].id
  }
  if (!regionId) throw new Error('US Region id unavailable after create')
  if (has('create_tax_region')) {
    await createTaxRegionsWorkflow(scope).run({ input: [{ country_code: 'us', provider_id: 'tp_system' }] })
  }

  const original = planUsCommercePack(before).resources
  let marketplaceId = original.marketplace_channel_id
  let operatingId = original.operating_channel_id
  const channelDefs: Array<{ name: string; description: string; target: 'marketplace' | 'operating' }> = []
  if (has('create_marketplace_channel')) channelDefs.push({
    name: US_RESOURCE_NAMES.marketplace_channel,
    description: 'US marketplace publication subset.', target: 'marketplace',
  })
  if (has('create_operating_channel')) channelDefs.push({
    name: US_RESOURCE_NAMES.operating_channel,
    description: 'US buyability superset; publishable key links here only.', target: 'operating',
  })
  if (channelDefs.length) {
    const { result } = await createSalesChannelsWorkflow(scope).run({
      input: { salesChannelsData: channelDefs.map(({ name, description }) => ({ name, description })) },
    })
    channelDefs.forEach((def, i) => {
      if (def.target === 'marketplace') marketplaceId = result[i].id
      else operatingId = result[i].id
    })
  }
  if (!marketplaceId || !operatingId) throw new Error('both US Sales Channel ids are required')

  let apiKeyId = original.api_key_id
  if (has('create_publishable_key')) {
    const { result } = await createApiKeysWorkflow(scope).run({ input: { api_keys: [{
      title: US_RESOURCE_NAMES.api_key, type: 'publishable', created_by: 'internal/us-commerce-provision',
    }] } })
    apiKeyId = result[0].id
  }
  if (!apiKeyId) throw new Error('US API-key row id unavailable after create')

  let locationId = original.stock_location_id
  if (has('create_stock_location')) {
    const { result } = await createStockLocationsWorkflow(scope).run({ input: { locations: [{
      name: US_RESOURCE_NAMES.stock_location,
      address: { city: '', address_1: '', country_code: 'US' },
    }] } })
    locationId = result[0].id
  }
  if (!locationId) throw new Error('US stock-location id unavailable after create')

  if (has('link_manual_provider')) {
    await link.create({
      [Modules.STOCK_LOCATION]: { stock_location_id: locationId },
      [Modules.FULFILLMENT]: { fulfillment_provider_id: 'manual_manual' },
    })
  }
  const addChannels = [
    ...(has('link_location_marketplace_channel') ? [marketplaceId] : []),
    ...(has('link_location_operating_channel') ? [operatingId] : []),
  ]
  if (addChannels.length) {
    await linkSalesChannelsToStockLocationWorkflow(scope).run({ input: { id: locationId, add: addChannels } })
  }
  if (has('link_key_operating_channel')) {
    await linkSalesChannelsToApiKeyWorkflow(scope).run({ input: { id: apiKeyId, add: [operatingId] } })
  }

  let fulfillmentSetId = original.fulfillment_set_id
  if (has('create_fulfillment_set')) {
    const [set] = await fulfillmentService.createFulfillmentSets([{
      name: US_RESOURCE_NAMES.fulfillment_set,
      type: 'shipping',
      service_zones: [{
        name: US_RESOURCE_NAMES.service_zone,
        geo_zones: [{ type: 'country', country_code: 'us' }],
      }],
    }])
    fulfillmentSetId = set.id
  }
  if (!fulfillmentSetId) throw new Error('US fulfillment-set id unavailable after create')
  if (has('link_location_fulfillment_set')) {
    await link.create({
      [Modules.STOCK_LOCATION]: { stock_location_id: locationId },
      [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSetId },
    })
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
