/**
 * Internal service route — attach a Clerk identity to an unclaimed seller
 * (Gem → Claimable Shop Loop · Sprint 2). Called server-to-server by the
 * frontend's POST /api/claim/complete after it verifies the claim JWT; this is
 * what actually transfers ownership — the storefront badge, /shop/manage and
 * /store/sellers/me all key off seller.clerk_user_id.
 *
 *   POST /internal/sellers/:id/claim   body: { clerk_user_id }
 *
 * Semantics: sets clerk_user_id iff currently NULL. Idempotent when already
 * claimed by the same user (200); 409 when owned by another user or when the
 * claimer already owns a different seller (clerk_user_id is unique).
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { id } = req.params
  const body = req.body as { clerk_user_id?: string }
  const clerkUserId = body.clerk_user_id?.trim()
  if (!clerkUserId) {
    return res.status(400).json({ message: 'clerk_user_id is required' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)

  const [seller] = await sellerService.listSellers({ id } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  if (seller.clerk_user_id === clerkUserId) {
    // Already claimed by this user — idempotent retry.
    return res.json({ seller, claimed: true })
  }
  if (seller.clerk_user_id) {
    return res.status(409).json({ message: 'Seller already claimed by another user' })
  }

  // clerk_user_id is unique across sellers — a user with an existing shop
  // can't absorb a second one through the claim flow.
  const [alreadyOwns] = await sellerService.listSellers({ clerk_user_id: clerkUserId }, { take: 1 })
  if (alreadyOwns) {
    return res.status(409).json({
      message: `User already owns seller '${alreadyOwns.slug}' — merging shops is not supported`,
    })
  }

  const updated = await sellerService.updateSellers({
    id: seller.id,
    clerk_user_id: clerkUserId,
    source: 'claimed',
  })

  res.json({ seller: updated, claimed: true })
}
