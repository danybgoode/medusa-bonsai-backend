/**
 * Seller-facing return request management.
 *
 * GET /store/sellers/me/orders/:id/return-request
 *   Returns the current return_request state.
 *
 * PATCH /store/sellers/me/orders/:id/return-request
 *   Body: { action: 'accept' | 'decline', refund_amount_cents?: number }
 *
 *   accept  → marks return as seller_accepted; if refund_amount_cents is provided
 *             (or defaults to order.total), triggers provider refund via
 *             refundPaymentWorkflow and records refund_status on the order.
 *   decline → marks return as declined, no refund.
 *
 * Auth: Clerk JWT — must be the seller of the product in the order.
 */

import Stripe from 'stripe'
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { refundPaymentWorkflow } from '@medusajs/medusa/core-flows'
import { resolveSeller } from '../../../../../_utils/clerk-auth'

async function resolveOrderForSeller(req: MedusaRequest, orderId: string) {
  const sellerAuth = await resolveSeller(req)
  if (!sellerAuth) return { order: null, sellerId: null, code: 401 as const }

  const orderService: any = req.scope.resolve(Modules.ORDER)
  const remoteQuery = req.scope.resolve(ContainerRegistrationKeys.REMOTE_QUERY)

  const [order] = await orderService.listOrders(
    { id: orderId },
    { select: ['id', 'status', 'payment_status', 'total', 'currency_code', 'email', 'metadata'], relations: ['items'] }
  )
  if (!order) return { order: null, sellerId: null, code: 404 as const }

  // Verify order belongs to this seller
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
    fields: ['id', 'payment_collections.payments.id', 'payment_collections.payments.provider_id'],
    filters: { id: orderId },
  })
  return (data?.[0] as any)?.payment_collections?.[0]?.payments?.[0]?.id ?? null
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params
  const { order, code } = await resolveOrderForSeller(req, orderId)
  if (!order) return res.status(code).json({ message: code === 401 ? 'Unauthorized' : code === 403 ? 'Forbidden' : 'Order not found' })

  const meta = (order.metadata ?? {}) as Record<string, unknown>
  return res.json({ return_request: meta.return_request ?? null })
}

// ── PATCH — accept / decline ──────────────────────────────────────────────────

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params
  const { order, code } = await resolveOrderForSeller(req, orderId)
  if (!order) return res.status(code).json({ message: code === 401 ? 'Unauthorized' : code === 403 ? 'Forbidden' : 'Order not found' })

  const body = (req.body ?? {}) as { action?: string; refund_amount_cents?: number }
  if (!['accept', 'decline'].includes(body.action ?? '')) {
    return res.status(422).json({ message: 'action must be "accept" or "decline"' })
  }

  const meta = (order.metadata ?? {}) as Record<string, unknown>
  const returnRequest = (meta.return_request ?? null) as Record<string, unknown> | null

  if (!returnRequest) return res.status(404).json({ message: 'No return request found for this order' })
  if (returnRequest.status === 'refunded') return res.status(409).json({ message: 'Return already refunded' })
  if (returnRequest.status === 'declined') return res.status(409).json({ message: 'Return already declined' })

  const orderService: any = req.scope.resolve(Modules.ORDER)
  const now = new Date().toISOString()

  if (body.action === 'decline') {
    await orderService.updateOrders(orderId, {
      metadata: {
        ...meta,
        return_request: {
          ...returnRequest,
          status: 'declined',
          seller_action: 'declined',
          seller_action_at: now,
        },
      },
    })
    return res.json({ return_request: { ...returnRequest, status: 'declined', seller_action: 'declined', seller_action_at: now } })
  }

  // ── Accept + refund/void ──────────────────────────────────────────────────
  const refundAmountCents = body.refund_amount_cents != null
    ? Math.round(body.refund_amount_cents)
    : Math.round(Number(returnRequest.order_total_cents ?? order.total ?? 0))

  if (refundAmountCents <= 0) {
    return res.status(422).json({ message: 'refund_amount_cents must be greater than 0' })
  }

  // Escrow + not yet captured → void the authorization (no money moved; nothing to refund)
  const isEscrowVoid = !!(meta.escrow_mode && !meta.escrow_captured)

  // Mark accepted immediately
  await orderService.updateOrders(orderId, {
    metadata: {
      ...meta,
      return_request: {
        ...returnRequest,
        status: 'accepted',
        seller_action: 'accepted',
        seller_action_at: now,
        refund_status: isEscrowVoid ? 'voiding' : 'pending',
        refund_amount_cents: refundAmountCents,
      },
    },
  })

  const paymentId = await getOrderPaymentId(req, orderId)

  if (isEscrowVoid) {
    // Void the PaymentIntent — the authorization hold is released, no money moves
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    let paymentIntentId: string | null = null
    try {
      const { data: payData } = await (query as any).graph({
        entity: 'order',
        fields: ['id', 'payment_collections.payments.id', 'payment_collections.payments.data'],
        filters: { id: orderId },
      })
      const paymentData = (payData?.[0] as any)?.payment_collections?.[0]?.payments?.[0]?.data as Record<string, unknown> | undefined
      paymentIntentId = (paymentData?.stripe_payment_intent as string | undefined) ?? null
    } catch { /* non-fatal */ }

    if (paymentIntentId) {
      try {
        const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-09-30.clover' as any })
        await stripeClient.paymentIntents.cancel(paymentIntentId)
      } catch (e) {
        const errMsg = (e as Error).message ?? 'Void failed'
        await orderService.updateOrders(orderId, {
          metadata: {
            ...meta,
            return_request: {
              ...returnRequest,
              status: 'accepted',
              seller_action: 'accepted',
              seller_action_at: now,
              refund_status: 'failed',
              refund_error: errMsg,
            },
          },
        })
        return res.status(502).json({ message: `No se pudo anular el cargo: ${errMsg}` })
      }
    }

    await orderService.updateOrders(orderId, {
      payment_status: 'canceled',
      metadata: {
        ...meta,
        return_request: {
          ...returnRequest,
          status: 'refunded',
          seller_action: 'accepted',
          seller_action_at: now,
          refund_status: 'voided',
          refund_amount_cents: refundAmountCents,
          refunded_at: now,
        },
        escrow_captured: false,
      },
    })
    return res.json({ refunded: true, refund_status: 'voided', refund_amount_cents: refundAmountCents, note: 'Escrow authorization voided — no money was charged' })
  }

  // Non-escrow or already-captured: standard refund flow
  if (!paymentId) {
    // No payment linked (e.g. SPEI/cash order) — mark as manual refund required
    await orderService.updateOrders(orderId, {
      metadata: {
        ...meta,
        return_request: {
          ...returnRequest,
          status: 'refunded',
          seller_action: 'accepted',
          seller_action_at: now,
          refund_status: 'manual',
          refund_amount_cents: refundAmountCents,
          refunded_at: now,
        },
      },
    })
    return res.json({ refunded: true, refund_status: 'manual', refund_amount_cents: refundAmountCents, note: 'No payment found — manual refund required' })
  }

  try {
    await refundPaymentWorkflow(req.scope).run({
      input: { payment_id: paymentId, amount: refundAmountCents },
    })
  } catch (e) {
    const errMsg = (e as Error).message ?? 'Refund failed'
    await orderService.updateOrders(orderId, {
      metadata: {
        ...meta,
        return_request: {
          ...returnRequest,
          status: 'accepted',
          seller_action: 'accepted',
          seller_action_at: now,
          refund_status: 'failed',
          refund_error: errMsg,
          refund_amount_cents: refundAmountCents,
        },
      },
    })
    return res.status(502).json({ message: `Refund failed: ${errMsg}` })
  }

  await orderService.updateOrders(orderId, {
    payment_status: 'refunded',
    metadata: {
      ...meta,
      return_request: {
        ...returnRequest,
        status: 'refunded',
        seller_action: 'accepted',
        seller_action_at: now,
        refund_status: 'refunded',
        refund_amount_cents: refundAmountCents,
        refunded_at: now,
      },
    },
  })

  return res.json({ refunded: true, refund_status: 'refunded', refund_amount_cents: refundAmountCents })
}
