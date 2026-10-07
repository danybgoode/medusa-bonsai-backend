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
import { Modules } from '@medusajs/framework/utils'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'
import { sellerRowEnforcement } from '../../../../../lib/seller-status'

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
  const locking = req.scope.resolve(Modules.LOCKING) as {
    execute: <T>(key: string, fn: () => Promise<T>, opts?: { timeout?: number }) => Promise<T>
  }
  try {
    // The old read-then-write let two different invited contacts both see an
    // unclaimed shop. Serialize by seller, then re-read INSIDE the shared lock.
    // The unique clerk_user_id index still guards two shops claimed by one user.
    return await locking.execute(`seller-claim:${id}`, async () => {
      const [seller] = await sellerService.listSellers({ id } as never, { take: 1 })
      if (!seller) return res.status(404).json({ message: 'Seller not found' })

      if (seller.clerk_user_id === clerkUserId) {
        // Only a first transfer triggers the one-time welcome and conversion.
        return res.json({ seller, claimed: true, newly_claimed: false })
      }
      if (seller.clerk_user_id) {
        return res.status(409).json({ message: 'Seller already claimed by another user' })
      }
      const visibility = sellerRowEnforcement(seller)
      if (!visibility.present || !visibility.admits) {
        return res.status(409).json({ message: 'Seller is not active' })
      }

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
      return res.json({ seller: updated, claimed: true, newly_claimed: true })
    }, { timeout: 5 })
  } catch (error) {
    console.error('[seller claim] lock or transfer failed', error)
    return res.status(503).json({ message: 'Seller claim unavailable; retry safely' })
  }
}
