/**
 * PATCH /store/sellers/me/orders/:id/confirm-payment
 *
 * Seller marks SPEI/cash payment as received. Triggers capturePaymentWorkflow
 * on the system provider (pp_system_default), which records the capture and
 * sets the order's payment_status to 'paid'.
 *
 * Only allowed for orders with payment_method 'spei' or 'cash' that have not
 * yet been confirmed.
 *
 * Auth: Clerk JWT — must be the seller who owns the order's product.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { capturePaymentWorkflow } from '@medusajs/medusa/core-flows'
import { resolveSeller } from '../../../../../_utils/clerk-auth'

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

  // Reject outright when ownership can't be established at all (no resolvable
  // product ids on the order) — this route captures a payment and writes
  // order-level metadata, so silently allowing it through here would let any
  // authenticated seller confirm payment on any such order.
  const productIds = ((order.items ?? []) as any[]).map((i: any) => i.product_id).filter(Boolean)
  if (productIds.length === 0) return { order: null, sellerId: null, code: 403 as const }

  const { data: sellerRows } = await (remoteQuery as any).graph({
    entity: 'seller',
    fields: ['id', 'products.id'],
    filters: { id: sellerAuth.sellerId },
  })
  const sellerProductIds = new Set(((sellerRows?.[0] as any)?.products ?? []).map((p: any) => p.id as string))
  // Require ownership of EVERY item, not just one — capturing payment is an
  // ORDER-level action, so a seller who owns only some items must not be
  // able to trigger it for the whole order (cross-agent review catch,
  // 2026-07-07). A cart can only ever hold one seller's items in normal use
  // (lib/cart.ts on the frontend enforces this at checkout), so this is a
  // no-op for every real order today — pure defense-in-depth.
  const owns = productIds.every((pid: string) => sellerProductIds.has(pid))
  if (!owns) return { order: null, sellerId: null, code: 403 as const }

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

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params
  const { order, code } = await resolveOrderForSeller(req, orderId)
  if (!order) {
    return res.status(code).json({ message: code === 401 ? 'Unauthorized' : code === 403 ? 'Forbidden' : 'Order not found' })
  }

  const meta = (order.metadata ?? {}) as Record<string, unknown>
  const paymentMethod = meta.payment_method as string | undefined

  if (!['manual', 'spei', 'cash', 'dimo'].includes(paymentMethod ?? '')) {
    return res.status(422).json({ message: 'Este pedido no es de pago manual (SPEI/efectivo/DiMo).' })
  }

  if (meta.payment_received) {
    return res.status(409).json({ message: 'El pago ya fue confirmado para este pedido.' })
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
    console.error('[confirm-payment] capture failed:', msg)
    return res.status(502).json({ message: `No se pudo confirmar el pago: ${msg}` })
  }

  const now = new Date().toISOString()
  const orderService: any = req.scope.resolve(Modules.ORDER)

  await orderService.updateOrders(orderId, {
    metadata: {
      ...meta,
      payment_received: true,
      payment_received_at: now,
      payment_confirmed_by: 'seller',
    },
  })

  return res.json({
    confirmed: true,
    payment_received_at: now,
  })
}
