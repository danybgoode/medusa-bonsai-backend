/**
 * POST /store/sellers/stripe-sync
 *
 * Called by the Next.js Stripe webhook on account.updated events.
 * Finds the seller whose metadata.settings.stripe.account_id matches
 * the incoming Stripe account and updates their Stripe status flags.
 *
 * Body: { stripe_account_id, charges_enabled, details_submitted }
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { internalSecretMissing } from '../../../../lib/internal-auth'
import { findSellerByStripeAccount } from '../../_utils/seller-stripe-lookup'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  // This route flips `charges_enabled` — whether a seller can take card payments —
  // and lived UNAUTHENTICATED under `/store/`, so any anonymous caller could set it.
  //
  // The repo-wide fail-closed sweep that produced `internal-auth.ts` swept
  // `/internal/*`; this route escaped it purely by sitting under `/store/` while
  // doing privileged work. Guard the population, not the door you found.
  //
  // The caller (the storefront's Stripe `account.updated` webhook) began sending this
  // header in a prior frontend deploy, so enforcing it here breaks nothing.
  if (internalSecretMissing(req)) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const body = req.body as {
    stripe_account_id?: string
    charges_enabled?: boolean
    details_submitted?: boolean
  }

  if (!body.stripe_account_id) {
    return res.status(400).json({ message: 'stripe_account_id is required' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)

  // Paged scan — see `seller-stripe-lookup.ts` for why the old flat `take: 500` was
  // a silent correctness cliff rather than a harmless cap.
  const seller = await findSellerByStripeAccount(
    body.stripe_account_id,
    (skip, take) => sellerService.listSellers({}, { take, skip }),
  )

  if (!seller) {
    // Not an error — account may belong to a seller not yet in Medusa
    return res.json({ ok: true, found: false })
  }

  const meta = (seller.metadata ?? {}) as Record<string, unknown>
  const settings = (meta.settings ?? {}) as Record<string, unknown>
  const existingStripe = (settings.stripe ?? {}) as Record<string, unknown>

  await sellerService.updateSellers({
    id: seller.id,
    metadata: {
      ...meta,
      settings: {
        ...settings,
        stripe: {
          ...existingStripe,
          charges_enabled: body.charges_enabled ?? existingStripe.charges_enabled,
          details_submitted: body.details_submitted ?? existingStripe.details_submitted,
          onboarding_complete:
            (body.charges_enabled ?? existingStripe.charges_enabled) &&
            (body.details_submitted ?? existingStripe.details_submitted),
        },
      },
    },
  })

  return res.json({ ok: true, found: true, seller_id: seller.id })
}
