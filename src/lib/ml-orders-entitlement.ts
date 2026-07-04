/**
 * The `ml_sync` paid-SKU entitlement gate, ported to the backend (ml-orders-native
 * S2 · US-6). Sprint 1 gated order materialization on the GLOBAL `ml.orders_enabled`
 * kill-switch only — every entitled AND non-entitled seller got orders materialized
 * as long as that flag was on. This closes the gap: materialization additionally
 * requires the per-seller `ml_sync` entitlement, same SKU the frontend's
 * `lib/ml-sync-entitlement.ts` already gates the stock-sync toggle on.
 *
 * `deriveMlOrdersEntitlement` is a deliberate backend-native port of the frontend's
 * `deriveDomainEntitlement`/`deriveMlSyncEntitlement` (same grant shape, same
 * precedence) — no cross-app shared package exists in this architecture, so this
 * mirrors the already-established "keep two copies in lockstep" precedent
 * (`flags-cache.ts` duplicated the same way across both apps).
 *
 * The composer resolves everything the frontend seam does, but entirely
 * server-side: `clerk_user_id` via the backend's own `Seller` module (no round-trip
 * needed — the ML module's `seller_id` already IS that Medusa seller id), the grant
 * via the backend's read-only Supabase client (`marketplace_shops.metadata`, same
 * precedent as `store/home/personalization/route.ts`'s `readShop`), and the active
 * subscription via the SAME in-process `SubscriptionsModuleService` the
 * `/internal/ml-sync-subscription` route already uses (no HTTP self-call needed).
 */

import { supabaseRead } from '../api/store/_utils/supabase-read'
import { isEnabled } from './flags'
import { SELLER_MODULE } from '../modules/seller'
import type SellerModuleService from '../modules/seller/service'
import { SUBSCRIPTIONS_MODULE } from '../modules/subscriptions'
import type SubscriptionsModuleService from '../modules/subscriptions/service'
import { PLATFORM_SELLER_ID } from '../api/internal/setup-custom-domain-plan/route'
import { ML_SYNC_PLAN_KIND } from '../api/internal/setup-ml-sync-plan/route'

type Scope = { resolve: (key: string) => any }

// Same live-subscription window as `/internal/ml-sync-subscription` (`past_due`
// stays live — a grace window while Stripe retries the card).
const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due'])

export type MlSyncGrant = {
  type: 'grandfather' | 'comp' | 'one_time'
  granted_at: string
  expires_at?: string
  note?: string
}

/** Same defensive parse as the frontend's `readGrant` — a corrupt/half-written grant never entitles. */
export function readMlSyncGrant(metadata: unknown): MlSyncGrant | null {
  if (!metadata || typeof metadata !== 'object') return null
  const raw = (metadata as Record<string, unknown>).ml_sync_grant
  if (!raw || typeof raw !== 'object') return null
  const g = raw as Record<string, unknown>
  if (g.type !== 'grandfather' && g.type !== 'comp' && g.type !== 'one_time') return null
  if (typeof g.granted_at !== 'string' || g.granted_at === '') return null
  if (g.type === 'one_time' && (typeof g.expires_at !== 'string' || g.expires_at === '')) return null
  return {
    type: g.type,
    granted_at: g.granted_at,
    ...(typeof g.expires_at === 'string' && g.expires_at !== '' ? { expires_at: g.expires_at } : {}),
    ...(typeof g.note === 'string' ? { note: g.note } : {}),
  }
}

function isOneTimeGrantLive(grant: MlSyncGrant | null, now: Date): boolean {
  if (grant?.type !== 'one_time' || !grant.expires_at) return false
  const exp = Date.parse(grant.expires_at)
  return Number.isFinite(exp) && now.getTime() < exp
}

export type MlOrdersEntitlement = { entitled: boolean; reason: 'flag_off' | 'grandfathered' | 'comp' | 'one_time' | 'subscription' | 'none' }

/** Pure decision — same precedence as `deriveDomainEntitlement`. Never throws. */
export function deriveMlOrdersEntitlement(input: {
  paywallEnabled: boolean
  grant: MlSyncGrant | null
  hasActiveSubscription?: boolean
  now?: Date
}): MlOrdersEntitlement {
  if (!input.paywallEnabled) return { entitled: true, reason: 'flag_off' }
  if (input.grant?.type === 'grandfather') return { entitled: true, reason: 'grandfathered' }
  if (input.grant?.type === 'comp') return { entitled: true, reason: 'comp' }
  if (isOneTimeGrantLive(input.grant, input.now ?? new Date())) return { entitled: true, reason: 'one_time' }
  if (input.hasActiveSubscription) return { entitled: true, reason: 'subscription' }
  return { entitled: false, reason: 'none' }
}

async function readMlSyncGrantForClerkUser(clerkUserId: string): Promise<MlSyncGrant | null> {
  try {
    const { data, error } = await supabaseRead
      .from('marketplace_shops')
      .select('metadata')
      .eq('clerk_user_id', clerkUserId)
      .limit(1)
      .maybeSingle()
    if (error || !data) return null
    return readMlSyncGrant((data as { metadata: unknown }).metadata)
  } catch (e) {
    console.error('[ml-orders-entitlement] grant read failed (fails closed, non-fatal):', e)
    return null
  }
}

async function hasActiveMlSyncSubscription(scope: Scope, clerkUserId: string): Promise<boolean> {
  try {
    const subs: SubscriptionsModuleService = scope.resolve(SUBSCRIPTIONS_MODULE)
    const platformPlans: any[] = await (subs as any)
      .listSubscriptionPlans({ seller_id: PLATFORM_SELLER_ID }, { take: 100 })
      .catch(() => [])
    const plan = platformPlans.find((p) => (p?.metadata as Record<string, unknown> | null)?.kind === ML_SYNC_PLAN_KIND)
    if (!plan) return false
    const rows: any[] = await (subs as any)
      .listSubscriptions({ plan_id: plan.id, clerk_user_id: clerkUserId }, { take: 50 })
      .catch(() => [])
    return rows.some((r) => LIVE_SUBSCRIPTION_STATUSES.has(r?.status))
  } catch (e) {
    console.error('[ml-orders-entitlement] subscription check failed (fails closed, non-fatal):', e)
    return false
  }
}

/**
 * Resolve the `ml_sync` entitlement for a Medusa seller id — everything server-
 * side, no HTTP self-call. Fails closed (not entitled) on any lookup error; only
 * an unclaimed shop (`clerk_user_id` null) or the paywall itself being off are
 * NOT errors — the former can never hold a grant, the latter ungates everyone.
 */
export async function resolveMlOrdersEntitlement(scope: Scope, sellerId: string): Promise<MlOrdersEntitlement> {
  const paywallEnabled = await isEnabled('ml.sync_paywall_enabled')
  if (!paywallEnabled) return { entitled: true, reason: 'flag_off' } // ungated — skip the Supabase/subscription reads entirely

  const sellerService: SellerModuleService = scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ id: sellerId } as never, { take: 1 })
  const clerkUserId = (seller as { clerk_user_id?: string | null } | undefined)?.clerk_user_id
  if (!clerkUserId) return { entitled: false, reason: 'none' } // unclaimed shop — can't hold a grant or subscription

  const [grant, hasActiveSubscription] = await Promise.all([
    readMlSyncGrantForClerkUser(clerkUserId),
    hasActiveMlSyncSubscription(scope, clerkUserId),
  ])
  return deriveMlOrdersEntitlement({ paywallEnabled, grant, hasActiveSubscription })
}
