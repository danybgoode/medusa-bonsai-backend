/**
 * Internal service route — set a product's homepage-Selección pin on behalf of a
 * platform ADMIN (Homepage Selección · Sprint 2). Unlike the seller-scoped
 * `/internal/seller-products/[id]` route, this is NOT ownership-checked: an admin
 * may feature ANY shop's product. The Next.js frontend gates the caller with
 * `withAdmin` (Clerk) before reaching here and holds the shared secret.
 *
 *   PATCH /internal/admin/featured/:id   body: { featured: boolean, featured_rank?: number | null }
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET (same as other
 * /internal routes). The write reuses the shared `updateSellerProduct` util so
 * the metadata deep-merge + the safe `updateProducts(id, data)` form (which dodges
 * Medusa's selector trap) are defined once and can't drift.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { updateSellerProduct } from '../../../../store/_utils/seller-product-update'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { id } = req.params
  const body = (req.body ?? {}) as { featured?: unknown; featured_rank?: unknown }

  if (typeof body.featured !== 'boolean') {
    return res.status(400).json({ message: 'featured (boolean) required' })
  }
  // featured_rank semantics: ABSENT ⇒ leave the existing rank untouched (the
  // metadata merge preserves it); explicit `null` ⇒ clear it; a finite number ⇒
  // set it. So a `{ featured: true }` call never silently wipes a stored rank.
  const metadata: Record<string, unknown> = { featured: body.featured }
  if ('featured_rank' in body) {
    if (body.featured_rank == null) {
      metadata.featured_rank = null
    } else {
      const n = Number(body.featured_rank)
      if (!Number.isFinite(n)) return res.status(400).json({ message: 'featured_rank must be a number or null' })
      metadata.featured_rank = n
    }
  }

  const result = await updateSellerProduct(req.scope, id, { metadata })
  if (!result.ok) return res.status(result.status).json({ message: result.message })

  res.json({ product_id: id, updated: true })
}
