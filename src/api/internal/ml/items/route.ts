/**
 * Internal service route — list a connected seller's active Mercado Libre items
 * as import-ready rows (Sprint 2 · import).
 *
 *   GET /internal/ml/items?seller_slug=...&offset=0&limit=50
 *     → { items: MlImportItem[], paging: { total, offset, limit } }
 *
 * Each item is sanitised (no tokens, no raw ML envelope) and annotated with
 * `already_linked` so the frontend can flag duplicates. The seller's access
 * token is materialised only inside the module and never crosses this boundary.
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

function toInt(v: unknown, fallback: number): number {
  const n = Number(firstString(v))
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const slug = firstString(req.query.seller_slug)
  if (!slug) return res.status(400).json({ message: 'seller_slug required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const offset = Math.max(0, toInt(req.query.offset, 0))
  const limit = Math.min(50, Math.max(1, toInt(req.query.limit, 50)))

  const ml: MercadolibreModuleService = req.scope.resolve(MERCADOLIBRE_MODULE)
  try {
    const { items, paging, skipped } = await ml.listActiveImportItems(seller.id, { offset, limit })
    return res.status(200).json({ items, paging, skipped })
  } catch (e) {
    const err = e as { code?: string; message?: string }
    if (err.code === 'ML_REAUTH_REQUIRED') {
      return res.status(409).json({ message: 'MercadoLibre re-authorization required', code: 'ML_REAUTH_REQUIRED' })
    }
    if (err.code === 'ML_NOT_CONNECTED') {
      return res.status(409).json({ message: 'No active MercadoLibre connection', code: 'ML_NOT_CONNECTED' })
    }
    return res.status(502).json({ message: err.message ?? 'Failed to fetch ML items' })
  }
}
