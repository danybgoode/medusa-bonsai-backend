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

export type PaymentMethodId = 'mercadopago' | 'stripe' | 'spei' | 'cash' | 'dimo'

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
  // Manual sub-methods all settle through the single unified manual provider.
  spei: 'pp_manual_manual',
  cash: 'pp_manual_manual',
  dimo: 'pp_manual_manual',
}

// Default selection preference (first available wins).
const DEFAULT_ORDER: PaymentMethodId[] = ['mercadopago', 'stripe', 'spei', 'dimo', 'cash']

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
  const checkout = (getSettings(seller).checkout ?? {}) as Record<string, any>
  const cash = (checkout.cash_pickup ?? {}) as Record<string, unknown>
  const shipping = (getSettings(seller).shipping ?? {}) as Record<string, unknown>
  // Cash at pickup requires local pickup to exist; enabled by default for back-
  // compat, but sellers can turn it off via settings.checkout.cash_pickup.enabled.
  return shipping.local_pickup === true && cash.enabled !== false
}

export function sellerHasDimo(seller: any): boolean {
  const dimo = ((getSettings(seller).checkout ?? {}).dimo ?? {}) as Record<string, unknown>
  const phone = typeof dimo.phone === 'string' ? dimo.phone.replace(/\D/g, '') : ''
  return dimo.enabled === true && phone.length >= 10
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
  opts?: { stripeEnabled?: boolean },
): { methods: PaymentMethod[]; default: PaymentMethodId | null } {
  // Platform kill-switch: when `checkout.stripe_enabled` is OFF, drop Stripe from
  // the catalog entirely (agents/UCP read this too). Defaults to on (fail-open).
  const stripeKilled = opts?.stripeEnabled === false
  const bankName = ((getSettings(seller).checkout ?? {}).bank_transfer ?? {}).bank_name as string | undefined

  const candidates: Array<{ ok: boolean; method: PaymentMethod }> = [
    {
      ok: sellerMpConnected(seller),
      method: { id: 'mercadopago', provider_id: PROVIDER_IDS.mercadopago, label: 'Mercado Pago', note: 'Tarjeta, wallet, OXXO y meses sin intereses.', instant: true },
    },
    {
      ok: sellerHasStripe(seller) && !stripeKilled,
      method: { id: 'stripe', provider_id: PROVIDER_IDS.stripe, label: 'Tarjeta', note: 'Checkout seguro de Stripe.', instant: true },
    },
    {
      ok: sellerHasSpei(seller),
      method: { id: 'spei', provider_id: PROVIDER_IDS.spei, label: 'SPEI', note: bankName ?? 'Transferencia bancaria interbancaria.', instant: false },
    },
    {
      ok: sellerHasDimo(seller),
      method: { id: 'dimo', provider_id: PROVIDER_IDS.dimo, label: 'DiMo', note: 'Transferencia por número de teléfono.', instant: false },
    },
    {
      ok: sellerHasCash(seller),
      method: { id: 'cash', provider_id: PROVIDER_IDS.cash, label: 'Efectivo al recoger', note: 'Pagas en efectivo al recoger tu pedido.', instant: false },
    },
  ]

  const regionSet = regionProviderIds && regionProviderIds.length ? new Set(regionProviderIds) : null

  const methods = candidates
    // Region intersection gates only the online card providers (these genuinely
    // vary by region). Manual sub-methods route through the single always-
    // registered pp_manual provider, so they're never region-gated.
    .filter(c => c.ok && (!c.method.instant || !regionSet || regionSet.has(c.method.provider_id)))
    .map(c => c.method)

  const available = new Set(methods.map(m => m.id))
  const def = DEFAULT_ORDER.find(id => available.has(id)) ?? null

  return { methods, default: def }
}
