import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../../modules/seller'
import SellerModuleService from '../../../../../../modules/seller/service'
import { extractClerkUserId } from '../../../../_utils/clerk-auth'
import { updateSellerProduct, type SellerProductUpdateBody } from '../../../../_utils/seller-product-update'
import { MAX_BULK_ITEMS, rejectOrchestrationOnlyPatch } from '../../../../_utils/catalog-bulk'
import { resolveSellerProductIds } from '../../../../_utils/seller-catalog-query'
import { isEnabled } from '../../../../../../lib/flags'

interface BulkApplyBody {
  items: Array<{ id: string; patch: SellerProductUpdateBody | null }>
}

export type BulkApplyItemResult = { id: string; ok: boolean; error?: string }

/**
 * POST /store/sellers/me/products/bulk-apply — catalog-management Sprint 3 ·
 * Story 3.1. Applies an already-staged, already-validated batch of per-product
 * patches in ONE request (never N sequential route calls from the frontend) —
 * loops in-process calling the same `updateSellerProduct()` every single-row
 * write already uses, per item in a try/catch (mirrors
 * `lib/supply-import.ts`'s `importApprovedItems()` idiom: non-fatal per-row
 * failure, no saga/rollback — partial apply is the intended behavior, not an
 * error). Re-validates each patch server-side as defense in depth; does NOT
 * trust the caller's staged diff blindly.
 *
 * Only for actions with NO frontend-side orchestration (price/category/
 * collection/inventory-mode). `pause_activate` (ML-close cascade, checkout-
 * viability gate, Supabase mirror) is applied by the FRONTEND calling its own
 * shared `setListingStatus()` per item instead — see catalog-bulk.ts's
 * doc comment and the Sprint 3 plan's "mid-build correction" note.
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

  const body = req.body as BulkApplyBody
  if (!Array.isArray(body?.items) || body.items.length === 0) {
    return res.status(422).json({ message: 'items es requerido.' })
  }
  if (body.items.length > MAX_BULK_ITEMS) {
    return res.status(422).json({ message: `El máximo por lote es ${MAX_BULK_ITEMS}.` })
  }

  // Ownership: updateSellerProduct() does NOT check this itself (its own doc
  // comment says callers must) — every single-row route already does, but
  // this bulk route originally didn't, letting a caller apply a patch to ANY
  // product id, not just this seller's own (cross-agent review catch, a
  // real IDOR the first review pass missed since it only checked bulk-stage,
  // which IS correctly scoped via querySellerCatalog).
  const ownedIds = await resolveSellerProductIds(req.scope, seller.id)

  const results: BulkApplyItemResult[] = []
  for (const item of body.items) {
    if (!ownedIds.has(item.id)) {
      results.push({ id: item.id, ok: false, error: 'Product not found in your shop' })
      continue
    }
    const rejectReason = rejectOrchestrationOnlyPatch(item.patch)
    if (rejectReason) {
      results.push({ id: item.id, ok: false, error: rejectReason })
      continue
    }
    try {
      // rejectOrchestrationOnlyPatch already refused a null patch above (the
      // `continue`), so item.patch is guaranteed non-null here.
      const result = await updateSellerProduct(req.scope, item.id, item.patch!, seller)
      results.push(result.ok ? { id: item.id, ok: true } : { id: item.id, ok: false, error: result.message })
    } catch (e) {
      results.push({ id: item.id, ok: false, error: e instanceof Error ? e.message : 'Error inesperado.' })
    }
  }

  res.json({ results })
}
