/**
 * Internal service route — change a seller's slug on behalf of the seller's
 * MCP agent (mcp-parity-config · Sprint 2). The agent has no Clerk JWT, so
 * the Next.js frontend (which holds the shared secret, has resolved the
 * agent token → shop, and has ALREADY validated the candidate against the
 * full frontend rule set — lib/slug.ts validateSlug, incl. the reserved-word
 * list) calls this with the shop's current slug.
 *
 * Uniqueness is authoritative HERE (Medusa owns seller.slug, mirroring the
 * store/sellers/me PATCH slug branch: same no-op, 422 format and 409
 * conflict semantics). Format + reserved words are re-checked with the SAME
 * exported validateSlug the store PATCH uses — one backend copy, so this
 * door can never drift into accepting a slug the portal would reject.
 *
 *   PATCH /internal/sellers/slug
 *         body: { seller_slug, new_slug,
 *                 previous_slugs?: [{slug,until}], previous_slug_keys?: string[] }
 *         → { seller_slug, previous_slug } (the now-old slug, for the caller's mirror)
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { validateSlug } from '../../../store/sellers/me/route'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const body = (req.body ?? {}) as {
    seller_slug?: string
    new_slug?: string
    previous_slugs?: Array<{ slug: string; until: string }>
    previous_slug_keys?: string[]
  }
  if (!body.seller_slug) return res.status(400).json({ message: 'seller_slug required' })

  const candidate = (body.new_slug ?? '').trim().toLowerCase()
  const invalid = validateSlug(candidate)
  if (invalid) return res.status(422).json({ message: invalid, field: 'slug' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug: body.seller_slug } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  if (candidate === seller.slug) {
    return res.json({ seller_slug: seller.slug, previous_slug: null })
  }

  const [conflict] = await sellerService.listSellers({ slug: candidate } as never, { take: 1 })
  if (conflict && conflict.id !== seller.id) {
    return res.status(409).json({ message: 'Ese slug ya está en uso.', field: 'slug' })
  }

  // Deep-merge metadata so the alias history rides alongside existing settings
  // (same merge shape as store/sellers/me PATCH).
  const metadata: Record<string, unknown> = { ...((seller.metadata as Record<string, unknown>) ?? {}) }
  if (body.previous_slugs !== undefined) metadata.previous_slugs = body.previous_slugs
  if (body.previous_slug_keys !== undefined) metadata.previous_slug_keys = body.previous_slug_keys

  await sellerService.updateSellers({ id: seller.id, slug: candidate, metadata })

  res.json({ seller_slug: candidate, previous_slug: seller.slug })
}
