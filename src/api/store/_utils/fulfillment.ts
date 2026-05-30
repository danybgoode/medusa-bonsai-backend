/**
 * Fulfillment infrastructure helpers.
 *
 * Provides idempotent create + runtime-resolve for Medusa FulfillmentSets and
 * ShippingOptions so the seller-PATCH workflow can call
 * createOrderFulfillmentWorkflow without needing a shipping method on the cart.
 *
 * Shipping options created here are named (stable slugs) so lookups are
 * deterministic without storing IDs in env vars.
 */

import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'

export const SHIPPING_OPTION_NAMES = {
  shipping: 'miyagi-envio-mexico',
  pickup:   'miyagi-recogida-tienda',
  digital:  'miyagi-entrega-digital',
} as const

// ---------------------------------------------------------------------------
// Runtime resolver — looks up option IDs by stable name
// ---------------------------------------------------------------------------

let cachedOptions: Record<string, string> | null = null

export async function resolveShippingOptionIds(
  scope: { resolve: (key: string) => any },
): Promise<Record<string, string>> {
  if (cachedOptions) return cachedOptions

  const fulfillmentService = scope.resolve(Modules.FULFILLMENT) as any
  const all: any[] = await fulfillmentService.listShippingOptions(
    {}, { select: ['id', 'name'], take: 100 },
  ).catch(() => [] as any[])
  const targetNames = new Set(Object.values(SHIPPING_OPTION_NAMES))
  const options = all.filter((o: any) => targetNames.has(o.name))

  const result: Record<string, string> = {}
  for (const opt of options) {
    for (const [key, name] of Object.entries(SHIPPING_OPTION_NAMES)) {
      if (opt.name === name) result[key] = opt.id
    }
  }

  if (Object.keys(result).length > 0) cachedOptions = result
  return result
}

export async function resolveStockLocationId(
  scope: { resolve: (key: string) => any },
): Promise<string | null> {
  const stockLocationService = scope.resolve(Modules.STOCK_LOCATION) as any
  const locations = await stockLocationService.listStockLocations(
    {}, { select: ['id'], take: 1, order: { created_at: 'ASC' } },
  ).catch(() => [] as any[])
  return locations[0]?.id ?? null
}

// ---------------------------------------------------------------------------
// Idempotent seed — called by POST /internal/setup-fulfillment
// ---------------------------------------------------------------------------

export async function setupFulfillmentInfrastructure(
  scope: { resolve: (key: string) => any },
): Promise<{ created: string[]; skipped: string[]; optionIds: Record<string, string> }> {
  const created: string[] = []
  const skipped: string[] = []

  const fulfillmentService = scope.resolve(Modules.FULFILLMENT) as any
  const remoteLink = scope.resolve(ContainerRegistrationKeys.LINK)

  // ── 1. Shipping profile ──────────────────────────────────────────────────
  const profiles = await fulfillmentService.listShippingProfiles(
    {}, { select: ['id', 'type'], take: 5 },
  ).catch(() => [] as any[])

  let profileId: string
  const defaultProfile = profiles.find((p: any) => p.type === 'default') ?? profiles[0]
  if (defaultProfile) {
    profileId = defaultProfile.id
    skipped.push('shipping_profile(default)')
  } else {
    const [p] = await fulfillmentService.createShippingProfiles([{
      name: 'Default',
      type: 'default',
    }])
    profileId = p.id
    created.push('shipping_profile')
  }

  // ── 2. FulfillmentSet + ServiceZone ────────────────────────────────────
  const allSets: any[] = await fulfillmentService.listFulfillmentSets(
    {}, { select: ['id', 'name'], relations: ['service_zones'], take: 50 },
  ).catch(() => [] as any[])
  const existingSets = allSets.filter((s: any) => s.name === 'Miyagi México')

  let fulfillmentSetId: string
  let serviceZoneId: string

  if (existingSets[0]) {
    fulfillmentSetId = existingSets[0].id
    serviceZoneId = existingSets[0].service_zones?.[0]?.id
    skipped.push('fulfillment_set')
  } else {
    const [set] = await fulfillmentService.createFulfillmentSets([{
      name: 'Miyagi México',
      type: 'shipping',
      service_zones: [{
        name: 'México',
        geo_zones: [{ type: 'country', country_code: 'mx' }],
      }],
    }])
    fulfillmentSetId = set.id
    serviceZoneId = set.service_zones[0].id
    created.push('fulfillment_set', 'service_zone', 'geo_zone')
  }

  // ── 3. Link FulfillmentSet ↔ StockLocation ────────────────────────────
  const locationId = await resolveStockLocationId(scope)
  if (locationId && fulfillmentSetId) {
    try {
      await remoteLink.create({
        [Modules.STOCK_LOCATION]: { stock_location_id: locationId },
        [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSetId },
      })
      created.push('location_fulfillment_link')
    } catch {
      skipped.push('location_fulfillment_link(already_exists)')
    }
  }

  // ── 4. Shipping options ────────────────────────────────────────────────
  if (!serviceZoneId) {
    return { created, skipped, optionIds: {} }
  }

  const allOptions: any[] = await fulfillmentService.listShippingOptions(
    {}, { select: ['id', 'name'], take: 100 },
  ).catch(() => [] as any[])
  const targetNames = new Set(Object.values(SHIPPING_OPTION_NAMES))
  const existingOptions = allOptions.filter((o: any) => targetNames.has(o.name))
  const existingNames = new Set(existingOptions.map((o: any) => o.name))

  const optionDefs = [
    {
      name: SHIPPING_OPTION_NAMES.shipping,
      label: 'Envío México (Envia.com)',
      code: 'standard',
    },
    {
      name: SHIPPING_OPTION_NAMES.pickup,
      label: 'Recogida en tienda',
      code: 'pickup',
    },
    {
      name: SHIPPING_OPTION_NAMES.digital,
      label: 'Entrega digital / servicio',
      code: 'digital',
    },
  ]

  const createdOptions: any[] = [...existingOptions]

  for (const def of optionDefs) {
    if (existingNames.has(def.name)) {
      skipped.push(`shipping_option(${def.name})`)
      continue
    }
    // price_type: calculated — we never add these options to a cart so
    // price calculation is never invoked; options are used only to attach
    // a provider + profile to createOrderFulfillmentWorkflow.
    const [opt] = await fulfillmentService.createShippingOptions([{
      name: def.name,
      service_zone_id: serviceZoneId,
      shipping_profile_id: profileId,
      provider_id: 'manual',
      price_type: 'calculated',
      type: { label: def.label, description: def.label, code: def.code },
    }])
    createdOptions.push(opt)
    created.push(`shipping_option(${def.name})`)
  }

  // Build option ID map
  const optionIds: Record<string, string> = {}
  for (const opt of createdOptions) {
    for (const [key, name] of Object.entries(SHIPPING_OPTION_NAMES)) {
      if (opt.name === name) optionIds[key] = opt.id
    }
  }

  // Warm the cache
  if (Object.keys(optionIds).length > 0) cachedOptions = optionIds

  return { created, skipped, optionIds }
}
