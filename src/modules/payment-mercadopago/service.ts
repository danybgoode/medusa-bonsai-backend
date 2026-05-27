/**
 * MercadoPago payment provider for Medusa v2.
 *
 * Flow:
 *   1. `start-checkout` creates an MP Preference (hosted checkout page),
 *      stores preference_id + checkout_url in the Medusa PaymentSession.data.
 *   2. `initiatePayment` is a no-op — data already set by start-checkout.
 *   3. `authorizePayment` fetches the payment by ID (stored after webhook)
 *      and returns "authorized" when status is "approved".
 *   4. `getWebhookActionAndData` handles MP payment.created / payment.updated
 *      IPN notifications.
 */

import { AbstractPaymentProvider, BigNumber } from '@medusajs/framework/utils'
import {
  InitiatePaymentInput,
  InitiatePaymentOutput,
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  ProviderWebhookPayload,
  WebhookActionResult,
  PaymentSessionStatus,
} from '@medusajs/framework/types'

type Options = {
  accessToken: string
}

export class MercadoPagoProviderService extends AbstractPaymentProvider<Options> {
  static identifier = 'mercadopago'

  static validateOptions(options: Record<string, unknown>) {
    if (!options.accessToken) throw new Error('MercadoPago accessToken is required')
  }

  private async mpFetch(path: string, options?: RequestInit) {
    const res = await fetch(`https://api.mercadopago.com${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
        ...(options?.headers ?? {}),
      },
    })
    return res.json()
  }

  // ── initiatePayment ───────────────────────────────────────────────────────
  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    return {
      id: (data.mp_preference_id as string) ?? 'pending',
      data,
    }
  }

  // ── authorizePayment ──────────────────────────────────────────────────────
  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>

    if (data.status === 'approved') {
      return { status: 'authorized' as PaymentSessionStatus, data }
    }

    const mpPaymentId = data.mp_payment_id as string
    if (!mpPaymentId) {
      return { status: 'pending' as PaymentSessionStatus, data }
    }

    try {
      const payment = await this.mpFetch(`/v1/payments/${mpPaymentId}`)
      if (payment.status === 'approved') {
        return { status: 'authorized' as PaymentSessionStatus, data: { ...data, status: 'approved', mp_status: payment.status } }
      }
      if (['cancelled', 'rejected', 'refunded'].includes(payment.status)) {
        return { status: 'canceled' as PaymentSessionStatus, data }
      }
      return { status: 'pending' as PaymentSessionStatus, data }
    } catch {
      return { status: 'error' as PaymentSessionStatus, data }
    }
  }

  // ── capturePayment ────────────────────────────────────────────────────────
  // MP payments are auto-captured.
  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    return { data: input.data ?? {} }
  }

  // ── cancelPayment ─────────────────────────────────────────────────────────
  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const mpPaymentId = data.mp_payment_id as string
    if (mpPaymentId) {
      try {
        await this.mpFetch(`/v1/payments/${mpPaymentId}`, {
          method: 'PUT',
          body: JSON.stringify({ status: 'cancelled' }),
        })
      } catch { /* best-effort */ }
    }
    return { data: { ...data, status: 'cancelled' } }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    if (data.status === 'approved') return { status: 'captured' as PaymentSessionStatus }
    return { status: 'pending' as PaymentSessionStatus }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const mpPaymentId = data.mp_payment_id as string
    if (!mpPaymentId) return { data }

    try {
      await this.mpFetch(`/v1/payments/${mpPaymentId}/refunds`, {
        method: 'POST',
        body: JSON.stringify({ amount: input.amount ? Number(input.amount) / 100 : undefined }),
      })
    } catch (e) {
      throw new Error(`MercadoPago refund failed: ${(e as Error).message}`)
    }
    return { data: { ...data, refunded: true } }
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    return { data: input.data ?? {} }
  }

  // ── getWebhookActionAndData ───────────────────────────────────────────────
  async getWebhookActionAndData(payload: ProviderWebhookPayload['payload']): Promise<WebhookActionResult> {
    const body = payload.data as Record<string, unknown>

    const topic = body.type ?? body.topic
    const dataId = (body.data as Record<string, unknown> | undefined)?.id
    const paymentId = String(dataId ?? body.id ?? '')

    if ((topic !== 'payment' && topic !== 'payment.created' && topic !== 'payment.updated') || !paymentId) {
      return { action: 'not_supported', data: { session_id: '', amount: new BigNumber(0) } }
    }

    try {
      const payment = await this.mpFetch(`/v1/payments/${paymentId}`)

      if (payment.status !== 'approved') {
        return { action: 'not_supported', data: { session_id: '', amount: new BigNumber(0) } }
      }

      const medusaSessionId = payment.metadata?.medusa_payment_session_id ?? ''
      const amountCents = Math.round((payment.transaction_amount ?? 0) * 100)

      return {
        action: 'authorized',
        data: {
          session_id: medusaSessionId,
          amount: new BigNumber(amountCents),
        },
      }
    } catch {
      return { action: 'failed', data: { session_id: '', amount: new BigNumber(0) } }
    }
  }
}

export default MercadoPagoProviderService
