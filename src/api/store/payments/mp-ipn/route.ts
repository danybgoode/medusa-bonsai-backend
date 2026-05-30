/**
 * POST /store/payments/mp-ipn
 *
 * Server-to-server endpoint called by the Next.js MercadoPago webhook. Verifies
 * a marketplace payment using the SELLER's MP token (resolved from the seller
 * id carried on the preference notification_url), and — if approved — patches
 * the cart's MP payment session so the subsequent /complete can authorize it.
 *
 * Keeping this on the backend means seller MP access tokens never leave the
 * Medusa service.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 * Body: { seller_id: string, payment_id: string }
 * Returns: { status, cart_id?, amount_cents?, buyer_email?, buyer_name?, metadata? }
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { IPaymentModuleService } from '@medusajs/framework/types'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { resolveSellerMpToken, getMpPaymentWithToken } from '../../_utils/mp'

const MP_PROVIDER_ID = 'pp_mercadopago_mercadopago'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const internalSecret = process.env.MEDUSA_INTERNAL_SECRET
  const headerSecret = req.headers['x-internal-secret'] as string | undefined
  if (internalSecret && headerSecret !== internalSecret) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const body = (req.body ?? {}) as { seller_id?: string; payment_id?: string }
  if (!body.seller_id || !body.payment_id) {
    return res.status(400).json({ message: 'seller_id and payment_id are required' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const paymentService: IPaymentModuleService = req.scope.resolve(Modules.PAYMENT)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const [seller] = await sellerService.listSellers({ id: body.seller_id } as any, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const token = await resolveSellerMpToken(sellerService, seller)
  if (!token) return res.status(422).json({ message: 'Seller MercadoPago not connected', code: 'SELLER_MP_NOT_CONNECTED' })

  const payment = await getMpPaymentWithToken(body.payment_id, token)
  if (!payment) return res.status(502).json({ message: 'Could not fetch MercadoPago payment' })

  if (payment.status !== 'approved') {
    return res.json({ status: payment.status ?? 'unknown' })
  }

  const meta = (payment.metadata ?? {}) as Record<string, any>
  const cartId = meta.cart_id as string | undefined
  const amountCents = Math.round((payment.transaction_amount ?? 0) * 100)
  const buyerEmail = payment.payer?.email ?? null
  const buyerName = [payment.payer?.first_name, payment.payer?.last_name].filter(Boolean).join(' ').trim() || null

  // Patch the cart's MP session so /complete can authorize it. The cart ↔
  // payment_collection link is a module link, so the collection id must be read
  // via the query graph (`payment_collection.id`) — it is NOT a column returned
  // by cartService.listCarts.
  if (cartId) {
    try {
      const { data: [cartGraph] } = await query.graph({
        entity: 'cart',
        fields: ['id', 'payment_collection.id'],
        filters: { id: cartId },
      })
      const collectionId = (cartGraph as any)?.payment_collection?.id as string | undefined
      if (collectionId) {
        const sessions = await paymentService.listPaymentSessions({ payment_collection_id: collectionId } as any)
        const mpSession = sessions.find((s: any) => s.provider_id === MP_PROVIDER_ID)
        if (mpSession) {
          await (paymentService as any).updatePaymentSession(mpSession.id, {
            data: { ...((mpSession.data as any) ?? {}), mp_payment_id: String(body.payment_id), status: 'approved' },
          })
        }
      }
    } catch (e) {
      console.error('[mp-ipn] session patch failed for cart', cartId, e)
    }
  }

  return res.json({
    status: 'approved',
    cart_id: cartId ?? null,
    amount_cents: amountCents,
    currency: (payment.currency_id ?? 'MXN').toUpperCase(),
    buyer_email: buyerEmail,
    buyer_name: buyerName,
    metadata: meta,
  })
}
