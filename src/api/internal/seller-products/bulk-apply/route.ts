/**
 * Internal service route — apply an already-staged bulk batch on behalf of
 * the seller's MCP agent (catalog-management epic, Sprint 3 · Story 3.3).
 * Same shared-secret pattern as the sibling `/internal/seller-products/:id`
 * PATCH.
 *
 *   POST /internal/seller-products/bulk-apply
 *   body: { seller_slug, items: [{ id, patch }] }
 *
 * Loops calling `updateSellerProduct()` per item — identical to the
 * Clerk-authed `/store/sellers/me/products/bulk-apply` route. Deliberately
 * does NOT cover `pause_activate`, `publish_channel` (ml), or `delete` —
 * those need the FRONTEND-side orchestration (Supabase mirror, ML cascade,
 * checkout-viability gate — see lib/listing-status.ts and
 * lib/ml-channel-toggle.ts) that only the Next.js layer can run; the agent
 * route rejects them with a clear message rather than silently skipping the
 * side effects a web-portal apply always runs. Story 3.3 scope: price,
 * category, collection_assign, inventory_mode, and publish_channel (miyagi)
 * — the field-patch-only actions.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { updateSellerProduct, type SellerProductUpdateBody } from '../../../store/_utils/seller-product-update'
import { MAX_BULK_ITEMS } from '../../../store/_utils/catalog-bulk'
import { isEnabled } from '../../../../lib/flags'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

interface BulkApplyBody {
  seller_slug?: string
  items: Array<{ id: string; patch: SellerProductUpdateBody }>
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  if (!(await isEnabled('catalog.bulk_enabled'))) {
    return res.status(423).json({ message: 'Esta función aún no está disponible.' })
  }

  const body = req.body as BulkApplyBody
  if (!body.seller_slug) return res.status(400).json({ message: 'seller_slug required' })
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return res.status(422).json({ message: 'items es requerido.' })
  }
  if (body.items.length > MAX_BULK_ITEMS) {
    return res.status(422).json({ message: `El máximo por lote es ${MAX_BULK_ITEMS}.` })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug: body.seller_slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const results: Array<{ id: string; ok: boolean; error?: string }> = []
  for (const item of body.items) {
    try {
      const result = await updateSellerProduct(req.scope, item.id, item.patch, seller)
      results.push(result.ok ? { id: item.id, ok: true } : { id: item.id, ok: false, error: result.message })
    } catch (e) {
      results.push({ id: item.id, ok: false, error: e instanceof Error ? e.message : 'Error inesperado.' })
    }
  }

  res.json({ results })
}
