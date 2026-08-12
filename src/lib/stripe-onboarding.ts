/**
 * US Stripe Connect onboarding decisions — the pure half.
 *
 * D14: new US accounts use the Accounts v2 `merchant` shape (USD/en-US defaults,
 * Stripe-collected fees and losses, full dashboard, hosted onboarding). Existing MX
 * v1 Express accounts are NOT migrated and this route never touches them.
 *
 * D17: the connected account is resolved SERVER-SIDE from the authenticated seller.
 * Nothing here accepts an account id from a caller — a request that could name its
 * own account could point a shop's payouts at someone else's Stripe.
 */
import { readSellerOperatingMarket } from './seller-market'
import { readSellerStripeSettings } from './stripe-market-strategy'
import { MARKETS } from './markets'

export type StripeOnboardingPlan =
  | { readonly action: 'create'; readonly market: 'us' }
  | { readonly action: 'reuse'; readonly market: 'us'; readonly account_id: string }
  | { readonly action: 'refuse'; readonly status: 422; readonly code: string; readonly message: string }

/**
 * Decide what onboarding this seller needs, from the seller row alone.
 *
 * MX is refused rather than silently handled: its sellers onboard through the
 * shipped v1 Express flow, and quietly creating a v2 account beside a working v1 one
 * would give a shop two connected accounts and an ambiguous payout destination.
 */
export function planStripeOnboarding(seller: unknown): StripeOnboardingPlan {
  const { market } = readSellerOperatingMarket(seller)
  if (!market) {
    return {
      action: 'refuse', status: 422, code: 'SELLER_MARKET_INVALID',
      message: 'This shop has no valid operating market.',
    }
  }
  if (market !== 'us') {
    return {
      action: 'refuse', status: 422, code: 'STRIPE_ONBOARDING_MARKET_UNSUPPORTED',
      message: `Stripe onboarding through this route is US-only; ${market.toUpperCase()} shops use the existing flow.`,
    }
  }

  const stripe = readSellerStripeSettings(seller)
  const accountId = typeof stripe.account_id === 'string' && stripe.account_id ? stripe.account_id : null

  // A v1 account on a US shop is a data problem, not something to onboard over: the
  // charge strategy would read api_generation and refuse anyway, and creating a
  // second account would leave two live destinations for one shop.
  if (accountId && stripe.api_generation && stripe.api_generation !== 'v2') {
    return {
      action: 'refuse', status: 422, code: 'STRIPE_ACCOUNT_GENERATION_CONFLICT',
      message: 'This shop already has a legacy Stripe account; it must be migrated before US payments.',
    }
  }

  return accountId ? { action: 'reuse', market: 'us', account_id: accountId } : { action: 'create', market: 'us' }
}

/**
 * The Accounts v2 create body for a US merchant, exactly the shape proven in D14 and
 * re-verified live on 2026-08-11.
 *
 * `locales` is plural and an array — `locale` is rejected by the API. Only
 * `card_payments` is requested: payouts are the connected account's own concern here,
 * and requesting a capability we never gate on would add requirements a seller must
 * clear for no reason.
 */
export function usAccountCreateParams(contactEmail: string, displayName: string) {
  return {
    display_name: displayName,
    contact_email: contactEmail,
    identity: { country: 'us', entity_type: 'individual' as const },
    configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
    defaults: {
      currency: MARKETS.us.currency_code,
      locales: [MARKETS.us.default_locale],
      responsibilities: { fees_collector: 'stripe' as const, losses_collector: 'stripe' as const },
    },
    dashboard: 'full' as const,
    include: ['configuration.merchant', 'identity', 'requirements'],
  }
}

/** Merge a fresh projection into a seller's existing settings without losing siblings. */
export function mergeStripeSettings(
  existingSettings: Record<string, unknown>,
  projection: Record<string, unknown>,
): Record<string, unknown> {
  const stripe = (existingSettings.stripe && typeof existingSettings.stripe === 'object'
    ? existingSettings.stripe
    : {}) as Record<string, unknown>
  return {
    ...existingSettings,
    // Projection last: it is the authoritative read from Stripe. Sibling keys the
    // projection does not own (enabled, onboarding_complete, MX's charges_enabled)
    // survive underneath rather than being blanked by a partial write.
    stripe: { ...stripe, ...projection },
  }
}
