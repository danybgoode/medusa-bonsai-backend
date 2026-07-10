import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../../modules/seller'
import SellerModuleService from '../../../../../../modules/seller/service'
import { extractClerkUserId } from '../../../../_utils/clerk-auth'
import { querySellerCatalog, type CatalogFilterParams } from '../../../../_utils/seller-catalog-query'
import { computeBulkDiff, MAX_BULK_ITEMS, type BulkActionPayload } from '../../../../_utils/catalog-bulk'
import { isEnabled } from '../../../../../../lib/flags'

interface BulkStageBody {
  filter?: CatalogFilterParams | null
  ids?: string[] | null
  action: BulkActionPayload
}

/**
 * POST /store/sellers/me/products/bulk-stage — catalog-management Sprint 3 ·
 * Story 3.1. Resolves the seller's target products (either an explicit id
 * list — the manual multi-select case — or the same filter the catalog table
 * itself uses — "seleccionar todos (N)"), computes a before/after diff PER
 * product for the requested action, and returns it. Pure resolve+validate:
 * NOTHING is written here. The caller (frontend) persists the returned diff
 * into its own staged-batch storage; a separate `bulk-apply` call actually
 * writes.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return res.status(401).json({ message: 'Authentication required' })

  if (!(await isEnabled('catalog.bulk_enabled'))) {
    return res.status(423).json({ message: 'Esta función aún no está disponible.' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (!seller) return res.status(404).json({ message: 'Seller profile not found' })

  const body = req.body as BulkStageBody
  if (!body?.action?.type) {
    return res.status(422).json({ message: 'action es requerido.' })
  }
  if (!body.ids?.length && !body.filter) {
    return res.status(422).json({ message: 'Debes indicar ids o un filtro.' })
  }
  // apply_suggested_price (S4 · 4.2) needs its own flag check — the other 7
  // action types must keep working with ops.profit_enabled off, so this
  // can't be a route-wide gate.
  if (body.action.type === 'apply_suggested_price' && !(await isEnabled('ops.profit_enabled'))) {
    return res.status(423).json({ message: 'Esta función aún no está disponible.' })
  }

  const filters: CatalogFilterParams = body.ids?.length
    ? { ids: body.ids }
    : { ...(body.filter ?? {}) }

  const { pairs } = await querySellerCatalog(req.scope, seller, filters)

  if (pairs.length === 0) {
    return res.json({ total: 0, valid_count: 0, invalid_count: 0, items: [] })
  }
  if (pairs.length > MAX_BULK_ITEMS) {
    return res.status(422).json({
      message: `Esta acción afecta ${pairs.length} productos — el máximo por lote es ${MAX_BULK_ITEMS}. Reduce el filtro y vuelve a intentar.`,
    })
  }

  const items = pairs.map((pair) => computeBulkDiff(pair, body.action))
  const validCount = items.filter((i) => i.valid).length

  res.json({
    total: items.length,
    valid_count: validCount,
    invalid_count: items.length - validCount,
    items,
  })
}
