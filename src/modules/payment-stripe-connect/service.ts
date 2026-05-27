/**
 * Stripe Connect Express payment provider for Medusa v2.
 *
 * Flow:
 *   1. `start-checkout` endpoint creates a Stripe Checkout Session (with
 *      transfer_data pointing at seller's connected account), stores the
 *      session ID + redirect URL in the Medusa PaymentSession.data.
 *   2. `initiatePayment` is a no-op — data is already set by start-checkout.
 *   3. `authorizePayment` fetches the Stripe session and returns "authorized"
 *      when it is paid/complete.
 *   4. `capturePayment` is a no-op — Stripe Checkout auto-captures.
 *   5. `getWebhookActionAndData` handles `checkout.session.completed` events
 *      so Medusa can automatically finalize orders on webhook delivery.
 */

import Stripe from 'stripe'
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
  apiKey: string
  webhookSecret: string
}

export class StripeConnectProviderService extends AbstractPaymentProvider<Options> {
  static identifier = 'stripe-connect'

  protected stripe_: Stripe

  constructor(container: Record<string, unknown>, options: Options) {
    super(container, options)
    this.stripe_ = new Stripe(options.apiKey, { apiVersion: '2025-09-30.clover' as any })
  }

  static validateOptions(options: Record<string, unknown>) {
    if (!options.apiKey) throw new Error('Stripe apiKey is required')
  }

  // ── initiatePayment ───────────────────────────────────────────────────────
  // The start-checkout endpoint pre-creates the Stripe session and passes its
  // data here. We just return it as-is so Medusa stores it on the session.
  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    return {
      id: (data.stripe_session_id as string) ?? 'pending',
      data,
    }
  }

  // ── authorizePayment ──────────────────────────────────────────────────────
  // Called when cart completion is attempted (either from success page or webhook).
  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>

    // If already marked as paid (by webhook flow), authorize immediately
    if (data.status === 'paid') {
      return { status: 'authorized' as PaymentSessionStatus, data }
    }

    const sessionId = data.stripe_session_id as string
    if (!sessionId) {
      return { status: 'pending' as PaymentSessionStatus, data }
    }

    try {
      const session = await this.stripe_.checkout.sessions.retrieve(sessionId)
      if (session.payment_status === 'paid') {
        return { status: 'authorized' as PaymentSessionStatus, data: { ...data, status: 'paid', stripe_payment_intent: session.payment_intent } }
      }
      if (session.status === 'expired') {
        return { status: 'canceled' as PaymentSessionStatus, data }
      }
      return { status: 'pending' as PaymentSessionStatus, data }
    } catch {
      return { status: 'error' as PaymentSessionStatus, data }
    }
  }

  // ── capturePayment ────────────────────────────────────────────────────────
  // Stripe Checkout auto-captures — nothing to do.
  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    return { data: input.data ?? {} }
  }

  // ── cancelPayment ─────────────────────────────────────────────────────────
  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const sessionId = data.stripe_session_id as string
    if (sessionId) {
      try {
        await this.stripe_.checkout.sessions.expire(sessionId)
      } catch { /* already expired or completed — ok */ }
    }
    return { data: { ...data, status: 'canceled' } }
  }

  // ── deletePayment ─────────────────────────────────────────────────────────
  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return this.cancelPayment(input)
  }

  // ── getPaymentStatus ──────────────────────────────────────────────────────
  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    if (data.status === 'paid') return { status: 'captured' as PaymentSessionStatus }

    const sessionId = data.stripe_session_id as string
    if (!sessionId) return { status: 'pending' as PaymentSessionStatus }

    try {
      const session = await this.stripe_.checkout.sessions.retrieve(sessionId)
      if (session.payment_status === 'paid') return { status: 'captured' as PaymentSessionStatus }
      if (session.status === 'expired') return { status: 'canceled' as PaymentSessionStatus }
      return { status: 'pending' as PaymentSessionStatus }
    } catch {
      return { status: 'error' as PaymentSessionStatus }
    }
  }

  // ── refundPayment ─────────────────────────────────────────────────────────
  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const paymentIntent = data.stripe_payment_intent as string
    if (!paymentIntent) return { data }

    try {
      await this.stripe_.refunds.create({
        payment_intent: paymentIntent,
        amount: input.amount ? Math.round(Number(input.amount)) : undefined,
        reverse_transfer: true,
      })
    } catch (e) {
      throw new Error(`Stripe refund failed: ${(e as Error).message}`)
    }
    return { data: { ...data, refunded: true } }
  }

  // ── retrievePayment ───────────────────────────────────────────────────────
  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    return { data: input.data ?? {} }
  }

  // ── updatePayment ─────────────────────────────────────────────────────────
  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    return { data: input.data ?? {} }
  }

  // ── getWebhookActionAndData ───────────────────────────────────────────────
  // Medusa calls this when POST /hooks/payment/pp_stripe-connect_stripe-connect fires.
  async getWebhookActionAndData(payload: ProviderWebhookPayload['payload']): Promise<WebhookActionResult> {
    const { data, rawData, headers } = payload

    // Verify signature
    const sig = (headers as Record<string, string>)['stripe-signature']
    let event: Stripe.Event
    try {
      event = this.stripe_.webhooks.constructEvent(
        rawData as string | Buffer,
        sig,
        this.config.webhookSecret,
      )
    } catch {
      return { action: 'not_supported', data: { session_id: '', amount: new BigNumber(0) } }
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session
      const sessionId = session.id
      const medusaSessionId = (session.metadata ?? {}).medusa_payment_session_id ?? ''
      const amount = session.amount_total ?? 0

      if (session.payment_status === 'paid') {
        return {
          action: 'authorized',
          data: {
            session_id: medusaSessionId || sessionId,
            amount: new BigNumber(amount),
          },
        }
      }
    }

    return { action: 'not_supported', data: { session_id: '', amount: new BigNumber(0) } }
  }
}

export default StripeConnectProviderService
