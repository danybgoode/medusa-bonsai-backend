/**
 * POST /internal/setup-fulfillment
 *
 * Idempotent one-time seed: creates the Medusa Fulfillment infrastructure
 * needed for native fulfillment workflows (E-full).
 *
 *   1. Ensures a ShippingProfile exists (reuses the default Medusa profile)
 *   2. Creates a FulfillmentSet "Miyagi México" with a ServiceZone + GeoZone(MX)
 *   3. Links the FulfillmentSet to the stock location
 *   4. Creates ShippingOptions (shipping / pickup / digital) backed by the
 *      manual provider (provider_id: 'manual')
 *
 * After running this, the seller PATCH route can call
 * createOrderFulfillmentWorkflow by passing shipping_option_id directly —
 * no shipping method on the cart required.
 *
 * Safe to re-run: each step checks before creating. Returns a report.
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { setupFulfillmentInfrastructure } from '../../store/_utils/fulfillment'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const secret = req.headers['x-internal-secret']
  if (!secret || secret !== process.env.MEDUSA_INTERNAL_SECRET) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  try {
    const result = await setupFulfillmentInfrastructure(req.scope)
    return res.json({ ok: true, ...result })
  } catch (e) {
    console.error('[setup-fulfillment]', e)
    return res.status(500).json({
      message: e instanceof Error ? e.message : String(e),
    })
  }
}
