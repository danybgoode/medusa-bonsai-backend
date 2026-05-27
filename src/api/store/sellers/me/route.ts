import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { extractClerkUserId } from '../../_utils/clerk-auth'

function slugify(text: string) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

// GET /store/sellers/me — fetch current seller profile (requires Clerk auth)
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) {
    return res.status(401).json({ message: 'Authentication required' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })

  if (!seller) {
    return res.status(404).json({ message: 'No seller profile found. POST to create one.' })
  }

  res.json({ seller })
}

// POST /store/sellers/me — create seller profile on first onboarding
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) {
    return res.status(401).json({ message: 'Authentication required' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)

  // Idempotent — return existing if already created
  const [existing] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (existing) {
    return res.json({ seller: existing })
  }

  const body = req.body as { name?: string; slug?: string; description?: string; location?: string }

  if (!body.name) {
    return res.status(400).json({ message: 'name is required' })
  }

  // Generate a unique slug
  let baseSlug = body.slug ? slugify(body.slug) : slugify(body.name)
  let slug = baseSlug
  let attempt = 0
  while (true) {
    const [conflict] = await sellerService.listSellers({ slug })
    if (!conflict) break
    slug = `${baseSlug}-${++attempt}`
  }

  const seller = await sellerService.createSellers({
    clerk_user_id: clerkUserId,
    slug,
    name: body.name,
    description: body.description ?? null,
    location: body.location ?? null,
    verified: false,
    metadata: {},
  })

  res.status(201).json({ seller })
}

// PATCH /store/sellers/me — update seller profile
export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) {
    return res.status(401).json({ message: 'Authentication required' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (!seller) {
    return res.status(404).json({ message: 'Seller not found' })
  }

  const body = req.body as {
    name?: string
    description?: string
    location?: string
    logo_url?: string
    metadata?: Record<string, unknown>
  }

  // Deep-merge metadata so partial updates don't overwrite existing settings
  const updatedMetadata = body.metadata
    ? { ...(seller.metadata as Record<string, unknown> ?? {}), ...body.metadata }
    : undefined

  const updated = await sellerService.updateSellers({
    id: seller.id,
    ...(body.name && { name: body.name }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.location !== undefined && { location: body.location }),
    ...(body.logo_url !== undefined && { logo_url: body.logo_url }),
    ...(updatedMetadata && { metadata: updatedMetadata }),
  })

  res.json({ seller: updated })
}
