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
import {
  resolveSellerProductIds,
  sellerOwnsEveryOrderItem,
} from '../../../../../_utils/seller-catalog-query'

async function resolveOrderForSeller(req: MedusaRequest, orderId: string) {
  const sellerAuth = await resolveSeller(req)
  if (!sellerAuth) return { order: null, sellerId: null, code: 401 as const }

  const orderService: any = req.scope.resolve(Modules.ORDER)
  const [order] = await orderService.listOrders(
    { id: orderId },
    { select: ['id', 'status', 'payment_status', 'total', 'currency_code', 'email', 'metadata'], relations: ['items'] }
  )
  if (!order) return { order: null, sellerId: null, code: 404 as const }

  // Verify order belongs to this seller
  const sellerProductIds = await resolveSellerProductIds(
    req.scope,
    sellerAuth.sellerId,
    { includeDeleted: true },
  )
  if (!sellerOwnsEveryOrderItem(sellerProductIds, order.items)) {
    return { order: null, sellerId: null, code: 403 as const }
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

  const body = (req.body ?? {}) as { action?: string; refund_amount_cents?: number; note?: string }
  if (!['accept', 'decline', 'seller_refund', 'transfer_sent'].includes(body.action ?? '')) {
    return res.status(422).json({ message: 'action must be "accept", "decline", "seller_refund", or "transfer_sent"' })
  }

  const meta = (order.metadata ?? {}) as Record<string, unknown>
  const orderService: any = req.scope.resolve(Modules.ORDER)
  const now = new Date().toISOString()

  // ── Resolve the return request to act on ──────────────────────────────────
  // For buyer-driven accept/decline there must already be a request. For a
  // seller-initiated refund there usually isn't one — synthesize a pre-approved,
  // seller-initiated record and then run the same refund engine below.
  let returnRequest = (meta.return_request ?? null) as Record<string, unknown> | null

  if (body.action === 'seller_refund') {
    // Guard: don't double-refund / fight an active buyer request.
    if (returnRequest && returnRequest.status !== 'declined') {
      if (returnRequest.status === 'refunded') {
        return res.status(409).json({ message: 'Order already refunded' })
      }
      return res.status(409).json({
        message: 'This order has an active return request — resolve it with accept/decline instead.',
      })
    }
    if (order.status === 'canceled' || order.payment_status === 'refunded' || order.payment_status === 'canceled') {
      return res.status(409).json({ message: 'Order is not refundable in its current state' })
    }
    returnRequest = {
      status: 'requested',
      reason: 'seller_initiated',
      description: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
      buyer_email: order.email ?? null,
      order_total_cents: order.total ?? 0,
      currency: order.currency_code ?? 'mxn',
      requested_at: now,
      initiated_by: 'seller',
      seller_action: null,
      seller_action_at: null,
      refund_status: null,
      refund_amount_cents: null,
      refunded_at: null,
    }
  } else {
    // Buyer-driven accept / decline / transfer_sent
    if (!returnRequest) return res.status(404).json({ message: 'No return request found for this order' })
    if (returnRequest.status === 'refunded') return res.status(409).json({ message: 'Return already refunded' })
    if (returnRequest.status === 'declined') return res.status(409).json({ message: 'Return already declined' })
  }

  // ── transfer_sent — off-platform (SPEI/cash) rail only ────────────────────
  // Seller confirms they sent the transfer: aceptado → transferencia_pendiente. This
  // never closes the refund — only the BUYER's "Recibí" does (S1.3). Guards keep it on
  // the ladder (no card orders, no double-mark, no skipping ahead).
  if (body.action === 'transfer_sent') {
    if (returnRequest!.refund_status !== 'manual') {
      return res.status(409).json({ message: 'Esta acción solo aplica a reembolsos por SPEI/efectivo.' })
    }
    if (returnRequest!.status !== 'accepted' || returnRequest!.transfer_sent_at) {
      return res.status(409).json({ message: 'La transferencia ya se marcó o el reembolso no está en el estado correcto.' })
    }
    const updated = { ...returnRequest, transfer_sent_at: now }
    await orderService.updateOrders(orderId, { metadata: { ...meta, return_request: updated } })
    return res.json({ return_request: updated, refund_state: 'transferencia_pendiente' })
  }

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
    return res.json({ return_request: { ...returnRequest, status: 'declined', seller_action: 'declined', seller_action_at: now }, refund_state: 'rechazado' })
  }

  // ── Accept (buyer) or seller_refund — refund/void ─────────────────────────
  const orderTotalCents = Math.round(Number(returnRequest.order_total_cents ?? order.total ?? 0))
  const refundAmountCents = body.refund_amount_cents != null
    ? Math.round(body.refund_amount_cents)
    : orderTotalCents

  if (refundAmountCents <= 0) {
    return res.status(422).json({ message: 'refund_amount_cents must be greater than 0' })
  }
  if (orderTotalCents > 0 && refundAmountCents > orderTotalCents) {
    return res.status(422).json({ message: 'refund_amount_cents cannot exceed the order total' })
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
    return res.json({ refunded: true, refund_status: 'voided', refund_state: 'confirmado', refund_amount_cents: refundAmountCents, note: 'Escrow authorization voided — no money was charged' })
  }

  // Non-escrow or already-captured: standard refund flow
  if (!paymentId) {
    // No on-platform payment (SPEI/cash): the refund is sent off-platform by the seller,
    // so accepting does NOT close it — that would claim money moved before it did. It
    // enters the two-sided ladder at `aceptado` (status:accepted + refund_status:manual,
    // no refunded_at). The seller then transfers and marks "Ya transferí"
    // (→ transferencia_pendiente), and the BUYER confirms receipt (→ confirmado, S1.3).
    await orderService.updateOrders(orderId, {
      metadata: {
        ...meta,
        return_request: {
          ...returnRequest,
          status: 'accepted',
          seller_action: 'accepted',
          seller_action_at: now,
          refund_status: 'manual',
          refund_amount_cents: refundAmountCents,
        },
      },
    })
    return res.json({ accepted: true, refund_status: 'manual', refund_state: 'aceptado', refund_amount_cents: refundAmountCents, note: 'Off-platform refund accepted — transfer pending' })
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

  return res.json({ refunded: true, refund_status: 'refunded', refund_state: 'confirmado', refund_amount_cents: refundAmountCents })
}
