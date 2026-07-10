/**
 * Internal service route — resolve + diff a bulk action on behalf of the
 * seller's MCP agent (catalog-management epic, Sprint 3 · Story 3.3). Same
 * shared-secret pattern as the sibling `/internal/seller-products/:id` PATCH:
 * the agent has no Clerk JWT, so the frontend (already resolved + ownership-
 * checked the agent token → shop) calls this with the shop slug instead.
 *
 *   POST /internal/seller-products/bulk-stage
 *   body: { seller_slug, filter?, ids?, action }
 *
 * Runs the EXACT same `querySellerCatalog`/`computeBulkDiff` logic the
 * Clerk-authed `/store/sellers/me/products/bulk-stage` route uses — an agent
 * can never see a different diff than a seller would for the same filter.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { querySellerCatalog, type CatalogFilterParams } from '../../../store/_utils/seller-catalog-query'
import { computeBulkDiff, MAX_BULK_ITEMS, type BulkActionPayload } from '../../../store/_utils/catalog-bulk'
import { isEnabled } from '../../../../lib/flags'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

interface BulkStageBody {
  seller_slug?: string
  filter?: CatalogFilterParams | null
  ids?: string[] | null
  action: BulkActionPayload
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  if (!(await isEnabled('catalog.bulk_enabled'))) {
    return res.status(423).json({ message: 'Esta función aún no está disponible.' })
  }

  const body = req.body as BulkStageBody | undefined
  if (!body?.seller_slug) return res.status(400).json({ message: 'seller_slug required' })
  if (!body?.action?.type) return res.status(422).json({ message: 'action es requerido.' })
  if (!body.ids?.length && !body.filter) {
    return res.status(422).json({ message: 'Debes indicar ids o un filtro.' })
  }
  // apply_suggested_price (S4 · 4.2) is not exposed to MCP agents this sprint
  // (no agent-facing tool computes a suggested price — that math lives in
  // the frontend's lib/profit.ts, which an MCP call has no access to) — the
  // frontend's stageBulkActionAsAgent()/isAgentUnsupportedAction() already
  // refuses it before ever reaching this route, but reject it here too as
  // defense in depth against a direct internal-secret caller.
  if (body.action.type === 'apply_suggested_price') {
    return res.status(422).json({ message: 'El precio sugerido en bloque aún no está disponible por el agente — usa la app web.' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug: body.seller_slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const filters: CatalogFilterParams = body.ids?.length ? { ids: body.ids } : { ...(body.filter ?? {}) }
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

  res.json({ total: items.length, valid_count: validCount, invalid_count: items.length - validCount, items })
}
