/**
 * POST /store/sellers/me/orders/:id/release-escrow
 *
 * Seller manually releases escrow funds (e.g. buyer confirmed verbally but
 * didn't tap the app button, or auto-confirm window elapsed). Triggers
 * capturePaymentWorkflow on the Stripe provider.
 *
 * Only for escrow orders where capture hasn't happened yet.
 * Auth: Clerk JWT — must be the seller of the order.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { capturePaymentWorkflow } from '@medusajs/medusa/core-flows'
import { resolveSeller } from '../../../../../_utils/clerk-auth'
import { logger } from '../../../../../../../lib/logger'

async function resolveOrderForSeller(req: MedusaRequest, orderId: string) {
  const sellerAuth = await resolveSeller(req)
  if (!sellerAuth) return { order: null, sellerId: null, code: 401 as const }

  const orderService: any = req.scope.resolve(Modules.ORDER)
  const remoteQuery = req.scope.resolve(ContainerRegistrationKeys.REMOTE_QUERY)

  const [order] = await orderService.listOrders(
    { id: orderId },
    { select: ['id', 'status', 'payment_status', 'metadata'], relations: ['items'] }
  )
  if (!order) return { order: null, sellerId: null, code: 404 as const }

  const productIds = ((order.items ?? []) as any[]).map((i: any) => i.product_id).filter(Boolean)
  if (productIds.length) {
    const { data: sellerRows } = await (remoteQuery as any).graph({
      entity: 'seller',
      fields: ['id', 'products.id'],
      filters: { id: sellerAuth.sellerId },
    })
    const sellerProductIds = new Set(((sellerRows?.[0] as any)?.products ?? []).map((p: any) => p.id as string))
    const owns = productIds.some((pid: string) => sellerProductIds.has(pid))
    if (!owns) return { order: null, sellerId: null, code: 403 as const }
  }

  return { order, sellerId: sellerAuth.sellerId, code: 200 as const }
}

async function getOrderPaymentId(req: MedusaRequest, orderId: string): Promise<string | null> {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await (query as any).graph({
    entity: 'order',
    fields: ['id', 'payment_collections.payments.id'],
    filters: { id: orderId },
  })
  return (data?.[0] as any)?.payment_collections?.[0]?.payments?.[0]?.id ?? null
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params
  const { order, code } = await resolveOrderForSeller(req, orderId)
  if (!order) {
    return res.status(code).json({ message: code === 401 ? 'Unauthorized' : code === 403 ? 'Forbidden' : 'Order not found' })
  }

  const meta = (order.metadata ?? {}) as Record<string, unknown>

  if (!meta.escrow_mode) {
    return res.status(422).json({ message: 'Este pedido no está en modo escrow.' })
  }

  if (meta.escrow_captured) {
    return res.status(409).json({ message: 'El pago ya fue liberado.' })
  }

  const paymentId = await getOrderPaymentId(req, orderId)
  if (!paymentId) {
    return res.status(422).json({ message: 'No se encontró el registro de pago para este pedido.' })
  }

  try {
    await capturePaymentWorkflow(req.scope).run({
      input: { payment_id: paymentId },
    })
  } catch (e) {
    const msg = (e as Error).message ?? 'Capture failed'
    logger.error('release-escrow', 'capture failed', { orderId, message: msg })
    return res.status(502).json({ message: `No se pudo liberar el pago: ${msg}` })
  }

  const now = new Date().toISOString()
  const orderService: any = req.scope.resolve(Modules.ORDER)

  await orderService.updateOrders(orderId, {
    metadata: {
      ...meta,
      escrow_captured: true,
      escrow_captured_at: now,
      escrow_released_by: 'seller',
    },
  })

  return res.json({
    released: true,
    escrow_captured_at: now,
  })
}
