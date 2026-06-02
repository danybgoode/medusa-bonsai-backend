/**
 * Unified manual ("Pago directo al vendedor") payment provider.
 *
 * One provider for all off-platform/manual payments — SPEI transfer, DiMo, cash
 * at pickup. The specific sub-type lives in the payment data + order metadata
 * (payment_method = 'spei' | 'cash' | 'dimo'), not as separate providers, so the
 * buyer sees a single "Pago directo" choice that expands to the seller's
 * configured instructions. Authorize-now / capture-on-seller-confirm (shared base).
 *
 * Provider id: pp_manual_manual. The legacy pp_spei_spei / pp_cash_cash providers
 * stay registered for any in-flight orders.
 */

import { ManualMxPaymentProvider } from '../payment-manual-mx/base'

export class ManualProviderService extends ManualMxPaymentProvider {
  static identifier = 'manual'
}

export default ManualProviderService
