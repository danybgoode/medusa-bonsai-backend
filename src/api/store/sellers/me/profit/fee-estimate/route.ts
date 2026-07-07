import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { resolveSeller } from '../../../../_utils/clerk-auth'
import { isEnabled } from '../../../../../../lib/flags'
import { MERCADOLIBRE_MODULE } from '../../../../../../modules/mercadolibre'
import type MercadolibreModuleService from '../../../../../../modules/mercadolibre/service'

/**
 * GET /store/sellers/me/profit/fee-estimate?category_id=&listing_type_id=&price_cents=
 * — ML's fee rate (percentage + fixed fee) for a category/listing-type, the
 * input the frontend's `solveForPrice` suggester needs (Sprint 2 · US-4).
 * Cached in the module service; degrades to `{ available: false }` on any ML
 * error or missing connection rather than failing the whole dashboard.
 *
 * Gate order: flag → auth (LEARNINGS — same as the rest of the epic).
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!(await isEnabled('ops.profit_enabled'))) {
    return res.status(404).json({ message: 'Not found' })
  }

  const sellerAuth = await resolveSeller(req)
  if (!sellerAuth) return res.status(401).json({ message: 'Unauthorized' })

  const categoryId = String(req.query.category_id ?? '').trim()
  const listingTypeId = String(req.query.listing_type_id ?? '').trim()
  const priceCents = Number(req.query.price_cents)
  if (!categoryId || !listingTypeId || !Number.isFinite(priceCents) || priceCents <= 0) {
    return res.status(422).json({ message: 'category_id, listing_type_id and a positive price_cents are required' })
  }

  const ml = req.scope.resolve(MERCADOLIBRE_MODULE) as MercadolibreModuleService
  const estimate = await ml.getFeeEstimate(sellerAuth.sellerId, {
    categoryId,
    listingTypeId,
    referencePriceCents: priceCents,
  })

  if (!estimate) return res.json({ available: false })
  return res.json({ available: true, ...estimate })
}
