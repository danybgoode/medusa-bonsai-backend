/**
 * Cash-on-pickup payment provider.
 *
 * Buyer pays cash when collecting the item in person; the order is created
 * immediately and the seller confirms receipt later. See ManualMxPaymentProvider
 * for the shared authorize-now / capture-on-confirm behavior.
 *
 * Provider id: pp_cash_cash
 */

import { ManualMxPaymentProvider } from '../payment-manual-mx/base'

export class CashProviderService extends ManualMxPaymentProvider {
  static identifier = 'cash'
}

export default CashProviderService
