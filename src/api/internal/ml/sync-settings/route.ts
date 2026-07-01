/**
 * Internal service route — per-seller stock-sync enable (Sprint 4 · US-12).
 * The two-way ML stock sync runs only when BOTH the global `ml.sync_enabled`
 * kill-switch AND this per-seller flag are on. During the proving phase this is
 * set by an admin/curl (the seller-facing toggle + activity log land in S5); the
 * flag lives on the ML connection metadata, co-located with the token + linkage.
 *
 *   GET  /internal/ml/sync-settings?seller_slug=…  → { sync_enabled }
 *   POST /internal/ml/sync-settings  body:{ seller_slug, enabled }  → { sync_enabled }
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

async function resolveSeller(req: MedusaRequest, sellerSlug: string) {
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug: sellerSlug } as never, { take: 1 })
  return seller ?? null
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })
  const sellerSlug = (req.query.seller_slug as string | undefined) ?? ''
  if (!sellerSlug) return res.status(400).json({ message: 'seller_slug required' })

  const seller = await resolveSeller(req, sellerSlug)
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const ml: MercadolibreModuleService = req.scope.resolve(MERCADOLIBRE_MODULE)
  const sync_enabled = await ml.isSellerSyncEnabled(seller.id)
  return res.status(200).json({ sync_enabled })
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })
  const { seller_slug, enabled } = (req.body ?? {}) as { seller_slug?: string; enabled?: boolean }
  if (!seller_slug || typeof enabled !== 'boolean') {
    return res.status(400).json({ message: 'seller_slug and boolean enabled required' })
  }

  const seller = await resolveSeller(req, seller_slug)
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const ml: MercadolibreModuleService = req.scope.resolve(MERCADOLIBRE_MODULE)
  try {
    const result = await ml.setSellerSyncEnabled(seller.id, enabled)
    return res.status(200).json(result)
  } catch (e) {
    const err = e as { code?: string; message?: string }
    if (err.code === 'ML_NOT_CONNECTED') {
      return res.status(409).json({ message: 'No MercadoLibre connection', code: 'ML_NOT_CONNECTED' })
    }
    return res.status(500).json({ message: err.message ?? 'Failed to set sync setting' })
  }
}
