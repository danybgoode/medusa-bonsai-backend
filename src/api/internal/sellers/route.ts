/**
 * Internal service route — create an UNCLAIMED seller for the supply pipeline
 * (Gem → Claimable Shop Loop · Sprint 1). The supply importer has no Clerk JWT;
 * the Next.js frontend (which holds the shared secret) calls this so curated
 * hidden gems become real Medusa sellers that render at /s/[slug] with the
 * "Sin reclamar" badge until their owner claims them.
 *
 *   POST /internal/sellers   body: { name, slug?, description?, location?,
 *           logo_url?, source?, source_url?, metadata? }
 *
 * Idempotent: when source_url is provided and a seller already exists with it,
 * that seller is returned (200) instead of creating a duplicate.
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET (same as the
 * sibling /internal/seller-products routes).
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

function slugify(text: string) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

interface CreateUnclaimedSellerBody {
  name?: string
  slug?: string
  description?: string | null
  location?: string | null
  logo_url?: string | null
  source?: string
  source_url?: string | null
  metadata?: Record<string, unknown>
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const body = req.body as CreateUnclaimedSellerBody
  const name = body.name?.trim()
  if (!name || name.length < 2) {
    return res.status(400).json({ message: 'name is required (min 2 characters)' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)

  // Idempotent on source provenance — re-importing the same external shop
  // returns the existing seller instead of minting a duplicate.
  const sourceUrl = body.source_url?.trim() || null
  if (sourceUrl) {
    const [existing] = await sellerService.listSellers({ source_url: sourceUrl } as never, { take: 1 })
    if (existing) {
      return res.json({ seller: existing, created: false })
    }
  }

  // Generate a unique slug (same scheme as POST /store/sellers/me)
  const baseSlug = slugify(body.slug?.trim() || name) || 'tienda'
  let slug = baseSlug
  let attempt = 0
  while (true) {
    const [conflict] = await sellerService.listSellers({ slug })
    if (!conflict) break
    slug = `${baseSlug}-${++attempt}`
  }

  const seller = await sellerService.createSellers({
    clerk_user_id: null,
    slug,
    name: name.slice(0, 80),
    description: body.description?.trim() || null,
    location: body.location?.trim() || null,
    logo_url: body.logo_url?.trim() || null,
    source: body.source?.trim() || 'scraped',
    source_url: sourceUrl,
    verified: false,
    metadata: body.metadata ?? {},
  })

  res.status(201).json({ seller, created: true })
}
