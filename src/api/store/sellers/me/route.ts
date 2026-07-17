import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { extractClerkUserId } from '../../_utils/clerk-auth'

export function slugify(text: string) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

// Slugs the storefront/platform can't give away — system routes and high-risk
// words. Keep in sync with the frontend's RESERVED_SLUGS (lib/slug.ts).
const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'sell', 'search', 'orders', 'inbox', 'profile', 'perfil',
  'ayuda', 'help', 's', 'shop', 'www', 'billing', 'support', 'soporte', 'account',
  'cuenta', 'sign-in', 'sign-up', 'embed', 'l', 'messages', 'mensajes', 'checkout',
  'cart', 'carrito', 'settings', 'ajustes', 'supply', 'terminos', 'mschz',
  // mschz-full-coverage (07, Sprint 1, US-1.2) — passthrough prefixes; defense-in-
  // depth (single-char slugs are already structurally impossible, min length 3).
  'g', 'e', 'v',
])

/**
 * Validate a seller-chosen slug. Returns an error message, or null if valid.
 * Format mirrors the frontend: 3–40 chars, lowercase alphanumeric + hyphens,
 * no leading/trailing hyphen, not reserved.
 */
function validateSlug(slug: string): string | null {
  if (slug.length < 3 || slug.length > 40) return 'El slug debe tener entre 3 y 40 caracteres.'
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    return 'Solo minúsculas, números y guiones; sin guion al inicio o al final.'
  }
  if (RESERVED_SLUGS.has(slug)) return 'Ese slug está reservado. Elige otro.'
  return null
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

  // Generate a unique slug. `|| 'tienda'` guards a name/slug that slugifies to
  // empty (all-emoji/punctuation/CJK) — without it this silently persists
  // slug: '', matching POST /internal/sellers' existing fallback for the same
  // reason (found live, 2026-07-15 — a seller-less orphaned catalog item
  // downstream got the frontend's "Unknown" placeholder with slug: '').
  let baseSlug = (body.slug ? slugify(body.slug) : slugify(body.name)) || 'tienda'
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
    slug?: string
    metadata?: Record<string, unknown>
  }

  // Slug change — validate format/reserved (422) + uniqueness (409). Only when it
  // actually differs from the current slug, so re-saving the profile is a no-op.
  let nextSlug: string | undefined
  if (body.slug !== undefined) {
    const candidate = body.slug.trim().toLowerCase()
    if (candidate !== seller.slug) {
      const invalid = validateSlug(candidate)
      if (invalid) return res.status(422).json({ message: invalid, field: 'slug' })
      const [conflict] = await sellerService.listSellers({ slug: candidate })
      if (conflict && conflict.id !== seller.id) {
        return res.status(409).json({ message: 'Ese slug ya está en uso.', field: 'slug' })
      }
      nextSlug = candidate
    }
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
    ...(nextSlug && { slug: nextSlug }),
    ...(updatedMetadata && { metadata: updatedMetadata }),
  })

  res.json({ seller: updated })
}
