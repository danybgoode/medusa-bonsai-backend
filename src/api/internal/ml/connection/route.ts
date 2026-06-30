/**
 * Internal service route — read or clear a seller's Mercado Libre connection.
 *
 *   GET    /internal/ml/connection?seller_slug=...   → { connection, health }
 *   DELETE /internal/ml/connection   body: { seller_slug }   → { ok }
 *
 * GET returns only the sanitised connection (no token fields) plus derived
 * health. DELETE disconnects (marks disconnected + clears encrypted tokens).
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { MERCADOLIBRE_MODULE } from '../../../../modules/mercadolibre'
import MercadolibreModuleService from '../../../../modules/mercadolibre/service'
import { sanitizeConnection, deriveConnectionHealth } from '../../../../modules/mercadolibre/_utils'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

function firstString(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined
  return typeof v === 'string' ? v : undefined
}

async function resolveSeller(req: MedusaRequest, slug: string) {
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug } as never, { take: 1 })
  return seller ?? null
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const slug = firstString(req.query.seller_slug)
  if (!slug) return res.status(400).json({ message: 'seller_slug required' })

  const seller = await resolveSeller(req, slug)
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const ml: MercadolibreModuleService = req.scope.resolve(MERCADOLIBRE_MODULE)
  const conn = await ml.getConnection(seller.id)
  res.status(200).json({
    connection: sanitizeConnection(conn),
    health: deriveConnectionHealth(conn),
  })
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { seller_slug } = (req.body ?? {}) as { seller_slug?: string }
  if (!seller_slug) return res.status(400).json({ message: 'seller_slug required' })

  const seller = await resolveSeller(req, seller_slug)
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const ml: MercadolibreModuleService = req.scope.resolve(MERCADOLIBRE_MODULE)
  await ml.disconnect(seller.id)
  res.status(200).json({ ok: true })
}
