/**
 * Shared base for Mexico manual payment providers (SPEI bank transfer + cash).
 *
 * These are "authorize now, capture on seller confirmation" methods:
 *   1. `start-checkout` records the method details (CLABE/bank for SPEI) in the
 *      PaymentSession.data — there is no external API to call.
 *   2. `authorizePayment` returns "authorized" so the cart completes into a real
 *      Medusa order immediately (payment_status stays not-captured / pending).
 *   3. The seller later confirms receipt via the confirm-payment route, which
 *      runs capturePaymentWorkflow → `capturePayment` here → order paid.
 *
 * Registering these as real Medusa payment providers (instead of riding on
 * pp_system_default) lets them appear in the Payment registry and be enabled
 * per Region, so seller shop-settings can toggle them as first-class methods.
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
  WebhookActionResult,
  PaymentSessionStatus,
} from '@medusajs/framework/types'

export abstract class ManualMxPaymentProvider extends AbstractPaymentProvider {
  // No options to validate — manual methods have no API credentials.
  static validateOptions() {}

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    return {
      // Use the cart's payment_method as a stable session id when present.
      id: (data.payment_method as string) ?? (this.constructor as any).identifier,
      data,
    }
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    // The order is created immediately; funds are confirmed out-of-band later.
    return { status: 'authorized' as PaymentSessionStatus, data: (input.data ?? {}) as Record<string, unknown> }
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    return { data: { ...data, payment_received: true } }
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    return { data: (input.data ?? {}) as Record<string, unknown> }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return { data: (input.data ?? {}) as Record<string, unknown> }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    return { status: (data.payment_received ? 'captured' : 'authorized') as PaymentSessionStatus }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    // Manual refunds happen off-platform (the seller returns the money directly).
    const data = (input.data ?? {}) as Record<string, unknown>
    return { data: { ...data, refunded: true } }
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    return { data: (input.data ?? {}) as Record<string, unknown> }
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    return { data: (input.data ?? {}) as Record<string, unknown> }
  }

  async getWebhookActionAndData(): Promise<WebhookActionResult> {
    // No webhooks for manual methods.
    return { action: 'not_supported', data: { session_id: '', amount: new BigNumber(0) } }
  }
}
