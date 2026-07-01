/**
 * Internal service route — predict valid Mercado Libre categories for a product
 * title (Sprint 3 · US-9). Backs the publish override UI: the FE shows the ranked
 * candidates and applies the low-confidence/override decision, so publish never
 * guesses a category silently. The seller's ML token is used only inside the
 * module.
 *
 *   GET /internal/ml/predict?seller_slug=...&q=<title>
 *     → { candidates: { category_id, category_name, score }[] }
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { MERCADOLIBRE_MODULE } from '../../../../modules/mercadolibre'
import MercadolibreModuleService from '../../../../modules/mercadolibre/service'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

function firstString(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined
  return typeof v === 'string' ? v : undefined
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const slug = firstString(req.query.seller_slug)
  const q = firstString(req.query.q)
  if (!slug) return res.status(400).json({ message: 'seller_slug required' })
  if (!q) return res.status(400).json({ message: 'q required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const ml: MercadolibreModuleService = req.scope.resolve(MERCADOLIBRE_MODULE)
  try {
    const candidates = await ml.predictMlCategory(seller.id, q)
    return res.status(200).json({ candidates })
  } catch (e) {
    const err = e as { code?: string; message?: string }
    if (err.code === 'ML_REAUTH_REQUIRED') return res.status(409).json({ message: 'MercadoLibre re-authorization required', code: 'ML_REAUTH_REQUIRED' })
    if (err.code === 'ML_NOT_CONNECTED') return res.status(409).json({ message: 'No active MercadoLibre connection', code: 'ML_NOT_CONNECTED' })
    return res.status(502).json({ message: err.message ?? 'Failed to predict category' })
  }
}
