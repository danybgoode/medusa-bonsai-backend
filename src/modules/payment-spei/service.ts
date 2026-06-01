/**
 * SPEI (Mexican interbank transfer) payment provider.
 *
 * Buyer wires funds to the seller's CLABE off-platform; the order is created
 * immediately and the seller confirms receipt later. See ManualMxPaymentProvider
 * for the shared authorize-now / capture-on-confirm behavior.
 *
 * Provider id: pp_spei_spei
 */

import { ManualMxPaymentProvider } from '../payment-manual-mx/base'

export class SpeiProviderService extends ManualMxPaymentProvider {
  static identifier = 'spei'
}

export default SpeiProviderService
