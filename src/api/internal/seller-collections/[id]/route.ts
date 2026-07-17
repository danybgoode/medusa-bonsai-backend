/**
 * Internal service route — rename / delete a seller's collection on behalf of
 * the seller's MCP agent (mcp-parity-config · Sprint 1). The agent has no
 * Clerk JWT, so the Next.js frontend (which holds the shared secret and has
 * already resolved + validated the agent token → shop) calls this with the
 * shop slug. Mirrors ../route.ts's auth + seller-resolution shape exactly;
 * the actual mutation logic is the same renameSellerCollection /
 * deleteSellerCollection the Clerk-authed store routes
 * (store/sellers/me/collections/:id) already use — ownership is re-checked
 * inside those shared utils.
 *
 *   PATCH  /internal/seller-collections/:id   body: { seller_slug, name }
 *   DELETE /internal/seller-collections/:id?seller_slug=…  (body fallback accepted)
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { renameSellerCollection, deleteSellerCollection } from '../../../store/_utils/seller-collections'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

async function resolveSeller(req: MedusaRequest, slug: string | undefined) {
  if (!slug) return null
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug } as never, { take: 1 })
  return seller ?? null
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { id } = req.params
  const body = (req.body ?? {}) as { seller_slug?: string; name?: string }
  const seller = await resolveSeller(req, body.seller_slug)
  if (!body.seller_slug) return res.status(400).json({ message: 'seller_slug required' })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const result = await renameSellerCollection(req.scope, seller.id, id, body.name ?? '')
  if (!result.ok) return res.status(result.status).json({ message: result.message })

  res.json({ ok: true })
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { id } = req.params
  const slug = (req.query.seller_slug as string | undefined)
    ?? (req.body as { seller_slug?: string } | undefined)?.seller_slug
  if (!slug) return res.status(400).json({ message: 'seller_slug required' })
  const seller = await resolveSeller(req, slug)
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const result = await deleteSellerCollection(req.scope, seller.id, id)
  if (!result.ok) return res.status(result.status).json({ message: result.message })

  res.json({ ok: true })
}
