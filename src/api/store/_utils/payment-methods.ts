/**
 * Single source of truth for "which payment methods does this seller offer".
 *
 * Resolves a seller's enabled payment methods from their Medusa seller metadata
 * (settings.*) and maps each to its registered Medusa payment provider id. Used
 * by the checkout-options endpoint (and validated server-side at start-checkout)
 * so the frontend never decides availability from raw metadata flags.
 *
 * Default preference order (decided with the product owner): MercadoPago →
 * Stripe → SPEI → Cash. The default resolves to the first AVAILABLE method.
 */

import { sellerMpConnected } from './mp'

export type PaymentMethodId = 'mercadopago' | 'stripe' | 'spei' | 'cash'

export type PaymentMethod = {
  id: PaymentMethodId
  /** Registered Medusa payment provider id (pp_<config>_<identifier>). */
  provider_id: string
  label: string
  note: string
  /** true = funds settle now; false = seller confirms receipt out-of-band. */
  instant: boolean
}

const PROVIDER_IDS: Record<PaymentMethodId, string> = {
  mercadopago: 'pp_mercadopago_mercadopago',
  stripe: 'pp_stripe-connect_stripe-connect',
  spei: 'pp_spei_spei',
  cash: 'pp_cash_cash',
}

// Default selection preference (first available wins).
const DEFAULT_ORDER: PaymentMethodId[] = ['mercadopago', 'stripe', 'spei', 'cash']

function getSettings(seller: any): Record<string, any> {
  const meta = (seller?.metadata ?? {}) as Record<string, unknown>
  return (meta.settings ?? {}) as Record<string, any>
}

export function sellerHasStripe(seller: any): boolean {
  const stripe = (getSettings(seller).stripe ?? {}) as Record<string, unknown>
  return !!(stripe.enabled !== false && stripe.account_id && stripe.charges_enabled)
}

export function sellerHasSpei(seller: any): boolean {
  const bt = ((getSettings(seller).checkout ?? {}).bank_transfer ?? {}) as Record<string, unknown>
  const clabe = typeof bt.clabe === 'string' ? bt.clabe.replace(/\D/g, '') : ''
  return bt.enabled !== false && clabe.length === 18
}

export function sellerHasCash(seller: any): boolean {
  const shipping = (getSettings(seller).shipping ?? {}) as Record<string, unknown>
  return shipping.local_pickup === true
}

/**
 * Returns the seller's enabled payment methods, intersected with the providers
 * registered on the cart's region (when supplied). Region intersection is a
 * safety net — in practice the Mexico region enables all four providers, so the
 * binding constraint is the seller's own configuration.
 */
export function resolveSellerPaymentMethods(
  seller: any,
  regionProviderIds?: string[],
): { methods: PaymentMethod[]; default: PaymentMethodId | null } {
  const bankName = ((getSettings(seller).checkout ?? {}).bank_transfer ?? {}).bank_name as string | undefined

  const candidates: Array<{ ok: boolean; method: PaymentMethod }> = [
    {
      ok: sellerMpConnected(seller),
      method: { id: 'mercadopago', provider_id: PROVIDER_IDS.mercadopago, label: 'Mercado Pago', note: 'Tarjeta, wallet, OXXO y meses sin intereses.', instant: true },
    },
    {
      ok: sellerHasStripe(seller),
      method: { id: 'stripe', provider_id: PROVIDER_IDS.stripe, label: 'Tarjeta', note: 'Checkout seguro de Stripe.', instant: true },
    },
    {
      ok: sellerHasSpei(seller),
      method: { id: 'spei', provider_id: PROVIDER_IDS.spei, label: 'SPEI', note: bankName ?? 'Transferencia bancaria interbancaria.', instant: false },
    },
    {
      ok: sellerHasCash(seller),
      method: { id: 'cash', provider_id: PROVIDER_IDS.cash, label: 'Efectivo al recoger', note: 'Pagas en efectivo al recoger tu pedido.', instant: false },
    },
  ]

  const regionSet = regionProviderIds && regionProviderIds.length ? new Set(regionProviderIds) : null

  const methods = candidates
    .filter(c => c.ok && (!regionSet || regionSet.has(c.method.provider_id)))
    .map(c => c.method)

  const available = new Set(methods.map(m => m.id))
  const def = DEFAULT_ORDER.find(id => available.has(id)) ?? null

  return { methods, default: def }
}
