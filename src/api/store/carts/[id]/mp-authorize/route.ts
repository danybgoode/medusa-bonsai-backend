/**
 * POST /store/carts/:id/mp-authorize
 *
 * Called by the Next.js MercadoPago IPN webhook handler after a payment is approved.
 * Patches the cart's MP payment session data with the real payment ID + approved status
 * so that the subsequent POST /store/carts/:id/complete can authorizePayment successfully.
 *
 * Body: { mp_payment_id: string }
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { ICartModuleService, IPaymentModuleService } from '@medusajs/framework/types'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id: cartId } = req.params
  const body = req.body as { mp_payment_id?: string }

  if (!body.mp_payment_id) {
    return res.status(400).json({ message: 'mp_payment_id is required' })
  }

  const cartService: ICartModuleService = req.scope.resolve(Modules.CART)
  const paymentService: IPaymentModuleService = req.scope.resolve(Modules.PAYMENT)

  // Load cart (need payment_collection_id)
  const [cart] = await cartService.listCarts({ id: cartId }, {})
  if (!cart) {
    return res.status(404).json({ message: 'Cart not found' })
  }

  const collectionId = (cart as unknown as Record<string, unknown>).payment_collection_id as string | undefined
  if (!collectionId) {
    return res.status(422).json({ message: 'Cart has no payment collection' })
  }

  // Find the MercadoPago session in this collection
  const sessions = await paymentService.listPaymentSessions({ payment_collection_id: collectionId })
  const mpSession = sessions.find(s => s.provider_id === 'pp_mercadopago_mercadopago')

  if (!mpSession) {
    return res.status(422).json({ message: 'No MercadoPago payment session found on this cart' })
  }

  // Patch session data with the real payment ID so authorizePayment can verify it
  const updatedData = {
    ...(mpSession.data as Record<string, unknown> ?? {}),
    mp_payment_id: body.mp_payment_id,
    status: 'approved',
  }

  await (paymentService as unknown as {
    updatePaymentSession(id: string, data: Record<string, unknown>): Promise<unknown>
  }).updatePaymentSession(mpSession.id, { data: updatedData })

  return res.json({ ok: true, session_id: mpSession.id })
}
