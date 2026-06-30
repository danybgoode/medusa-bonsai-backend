/**
 * Internal service route — complete the Mercado Libre OAuth exchange for a seller.
 *
 *   POST /internal/ml/connect   body: { seller_slug, code }
 *
 * The Clerk-authed frontend callback (which holds the shared secret and has
 * validated the OAuth `state`) posts the authorization `code` here. The exchange
 * + token storage happen entirely in the backend, so the cleartext tokens never
 * transit the frontend.
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET (same as the sibling
 * /internal/seller-products route).
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

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { seller_slug, code } = (req.body ?? {}) as { seller_slug?: string; code?: string }
  if (!seller_slug || !code) {
    return res.status(400).json({ message: 'seller_slug and code required' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug: seller_slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const ml: MercadolibreModuleService = req.scope.resolve(MERCADOLIBRE_MODULE)
  try {
    const connection = await ml.connectFromCode(seller.id, code)
    res.status(200).json({ connection })
  } catch (e) {
    // Never log the code or any token material.
    console.error('[internal/ml/connect] failed:', e instanceof Error ? e.message : 'unknown')
    res.status(502).json({ message: 'Mercado Libre connection failed' })
  }
}
