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

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = req.body as {
    stripe_account_id?: string
    charges_enabled?: boolean
    details_submitted?: boolean
  }

  if (!body.stripe_account_id) {
    return res.status(400).json({ message: 'stripe_account_id is required' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)

  // Find seller with this Stripe account ID (iterate — no JSON path index in custom module)
  const allSellers = await sellerService.listSellers({}, { take: 500 })

  const seller = allSellers.find(s => {
    const meta = (s.metadata ?? {}) as Record<string, unknown>
    const settings = (meta.settings ?? {}) as Record<string, unknown>
    const stripe = (settings.stripe ?? {}) as Record<string, unknown>
    return stripe.account_id === body.stripe_account_id
  })

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
