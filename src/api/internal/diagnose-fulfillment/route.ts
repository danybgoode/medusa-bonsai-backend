/**
 * GET /internal/diagnose-fulfillment  (READ-ONLY)
 *
 * Dumps the fulfillment + stock-location infrastructure so we can see duplicate
 * shipping profiles / fulfillment sets / stock locations (repeated-seeding cruft)
 * that cause:
 *   - completeCart "shipping profiles not satisfied" (product profile ≠ option profile)
 *   - admin /settings/locations crash ("null is not an object (o.name)")
 *
 * Auth: x-internal-secret header. No writes.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { internalSecretOk } from '../../../lib/internal-auth'

function authed(req: MedusaRequest): boolean {
  // Fail CLOSED: a missing MEDUSA_INTERNAL_SECRET denies everyone. One
  // definition, in src/lib/internal-auth.ts — see the incident note there.
  return internalSecretOk(req)
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!authed(req)) return res.status(401).json({ message: 'Unauthorized' })

  const fulfillment: any = req.scope.resolve(Modules.FULFILLMENT)
  const stockLocation: any = req.scope.resolve(Modules.STOCK_LOCATION)
  const query: any = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const out: Record<string, unknown> = {}

  // Shipping profiles
  const profiles = await fulfillment.listShippingProfiles({}, { select: ['id', 'name', 'type'], take: 100 }).catch((e: any) => ({ error: String(e) }))
  out.shipping_profiles = profiles

  // Shipping options (with their profile + provider + zone)
  const options = await fulfillment.listShippingOptions({}, {
    select: ['id', 'name', 'shipping_profile_id', 'provider_id', 'service_zone_id'],
    take: 100,
  }).catch((e: any) => ({ error: String(e) }))
  out.shipping_options = options

  // Fulfillment sets + service zones
  const sets = await fulfillment.listFulfillmentSets({}, { select: ['id', 'name'], relations: ['service_zones'], take: 100 }).catch((e: any) => ({ error: String(e) }))
  out.fulfillment_sets = Array.isArray(sets)
    ? sets.map((s: any) => ({ id: s.id, name: s.name, service_zones: (s.service_zones ?? []).map((z: any) => ({ id: z.id, name: z.name })) }))
    : sets

  // Stock locations (+ relations the admin location-list renders)
  const locations = await stockLocation.listStockLocations({}, { select: ['id', 'name'], take: 100 }).catch((e: any) => ({ error: String(e) }))
  out.stock_locations = locations

  // Stock locations via query graph WITH relations — this is closer to what the
  // admin renders; a null nested name here points at the o.name crash.
  try {
    const { data: locGraph } = await query.graph({
      entity: 'stock_location',
      fields: ['id', 'name', 'address.id', 'address.city', 'sales_channels.id', 'sales_channels.name', 'fulfillment_sets.id', 'fulfillment_sets.name', 'fulfillment_providers.id'],
      pagination: { take: 100, skip: 0 },
    })
    out.stock_locations_graph = locGraph
  } catch (e) {
    out.stock_locations_graph = { error: String(e) }
  }

  // Sample products with their shipping profile (does it match the options?)
  try {
    const { data: products } = await query.graph({
      entity: 'product',
      fields: ['id', 'title', 'shipping_profile.id', 'shipping_profile.name', 'shipping_profile.type'],
      pagination: { take: 10, skip: 0 },
    })
    out.sample_products = products
    out.product_profile_ids = Array.from(new Set((products ?? []).map((p: any) => p.shipping_profile?.id ?? null)))
  } catch (e) {
    out.sample_products = { error: String(e) }
  }

  return res.json(out)
}
