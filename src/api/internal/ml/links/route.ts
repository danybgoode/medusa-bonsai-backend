/**
 * Internal service route — the product↔ML-item linkage primitive (US-2).
 *
 *   POST   /internal/ml/links   body: { seller_slug, product_id, variant_id?, ml_item_id }
 *   GET    /internal/ml/links?product_id=...   | ?ml_item_id=...   (both-way lookup)
 *   DELETE /internal/ml/links   body: { id }
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

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { seller_slug, product_id, variant_id, ml_item_id } = (req.body ?? {}) as {
    seller_slug?: string
    product_id?: string
    variant_id?: string | null
    ml_item_id?: string
  }
  if (!seller_slug || !product_id || !ml_item_id) {
    return res.status(400).json({ message: 'seller_slug, product_id and ml_item_id required' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug: seller_slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const ml: MercadolibreModuleService = req.scope.resolve(MERCADOLIBRE_MODULE)
  try {
    const link = await ml.linkProductToMlItem({
      sellerId: seller.id,
      productId: product_id,
      variantId: variant_id ?? null,
      mlItemId: ml_item_id,
    })
    res.status(201).json({ link })
  } catch (e) {
    const conflict = (e as { code?: string }).code === 'ML_LINK_CONFLICT'
    res.status(conflict ? 409 : 500).json({
      message: conflict ? 'Product or ML item is already linked' : 'Failed to link',
    })
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const productId = firstString(req.query.product_id)
  const mlItemId = firstString(req.query.ml_item_id)
  if (!productId && !mlItemId) {
    return res.status(400).json({ message: 'product_id or ml_item_id required' })
  }

  const ml: MercadolibreModuleService = req.scope.resolve(MERCADOLIBRE_MODULE)
  const link = productId
    ? await ml.getLinkByProduct(productId)
    : await ml.getLinkByMlItem(mlItemId as string)
  res.status(200).json({ link: link ?? null })
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { id, seller_slug } = (req.body ?? {}) as { id?: string; seller_slug?: string }
  if (!id || !seller_slug) return res.status(400).json({ message: 'id and seller_slug required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug: seller_slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const ml: MercadolibreModuleService = req.scope.resolve(MERCADOLIBRE_MODULE)
  // Verify the link belongs to this seller before deleting (defense in depth —
  // the internal secret is a trusted boundary, but a known/colliding id must not
  // let one seller delete another's link).
  const link = await ml.getLink(id)
  if (!link || link.seller_id !== seller.id) {
    return res.status(404).json({ message: 'Link not found' })
  }
  await ml.unlink(id)
  res.status(200).json({ ok: true })
}
