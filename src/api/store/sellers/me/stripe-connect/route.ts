/**
 * US Stripe Connect onboarding + status for the authenticated seller.
 *
 *   POST /store/sellers/me/stripe-connect  → ensure a v2 account, return a hosted
 *                                            onboarding link
 *   GET  /store/sellers/me/stripe-connect  → re-read the account from Stripe, persist
 *                                            the projection, return readiness
 *
 * D17: the connected account is resolved SERVER-SIDE from the Clerk-authenticated
 * seller. Neither verb reads an account id, a return url or a readiness flag from the
 * caller — a request that could name its own account could point a shop's money at
 * someone else's Stripe, and a caller-supplied return url is an open redirect on a
 * page buyers are sent to.
 *
 * The thin half: every decision lives in `lib/stripe-onboarding.ts` and
 * `lib/stripe-account-projection.ts`, which are unit-tested without network.
 *
 * Uses fetch rather than the Stripe SDK: Accounts v2 (`/v2/core/accounts`) is not in
 * the pinned SDK's surface, and these exact calls were verified live on 2026-08-11.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'
import { extractClerkUserId } from '../../../_utils/clerk-auth'
import { projectStripeV2Account } from '../../../../../lib/stripe-account-projection'
import {
  mergeStripeSettings,
  planStripeOnboarding,
  usAccountCreateParams,
} from '../../../../../lib/stripe-onboarding'
import { resolveStripeReadiness } from '../../../../../lib/stripe-market-strategy'

const STRIPE_API = 'https://api.stripe.com'
/** Pinned: v2 core accounts shapes are version-sensitive and were verified on this. */
const STRIPE_VERSION = '2026-04-22.dahlia'
const SITE_URL = process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'

async function stripeV2(path: string, key: string, init?: { method?: string; body?: unknown }) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      'Stripe-Version': STRIPE_VERSION,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  })
  const json = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, json: json as Record<string, unknown> }
}

type ResolvedSeller =
  | { readonly error: { readonly status: number; readonly message: string } }
  | { readonly seller: { id: string; metadata?: unknown }; readonly sellerService: SellerModuleService }

async function resolveSeller(req: MedusaRequest): Promise<ResolvedSeller> {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return { error: { status: 401, message: 'Unauthorized' } }
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId } as never, { take: 1 })
  if (!seller) return { error: { status: 404, message: 'No shop for this account.' } }
  return { seller, sellerService }
}

/** Persist a fresh Stripe read onto the seller, preserving sibling settings. */
async function persistProjection(
  sellerService: SellerModuleService,
  seller: { id: string; metadata?: unknown },
  account: Record<string, unknown>,
) {
  const projection = projectStripeV2Account(account)
  if (!projection) return null
  const meta = (seller.metadata ?? {}) as Record<string, unknown>
  const settings = (meta.settings ?? {}) as Record<string, unknown>
  await sellerService.updateSellers({
    id: seller.id,
    metadata: { ...meta, settings: mergeStripeSettings(settings, { ...projection }) },
  } as never)
  return projection
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const resolved = await resolveSeller(req)
  if ('error' in resolved) return res.status(resolved.error.status).json({ message: resolved.error.message })
  const { seller, sellerService } = resolved

  const plan = planStripeOnboarding(seller)
  if (plan.action === 'refuse') return res.status(plan.status).json({ message: plan.message, code: plan.code })

  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return res.status(500).json({ message: 'Stripe not configured' })

  let accountId = plan.action === 'reuse' ? plan.account_id : null

  if (!accountId) {
    const email = (seller as { email?: string }).email ?? `shop+${seller.id}@miyagisanchez.com`
    const created = await stripeV2('/v2/core/accounts', key, {
      method: 'POST',
      body: usAccountCreateParams(email, (seller as { name?: string }).name ?? 'Miyagi shop'),
    })
    // A failed create must NOT return a green body: the seller would be told to
    // onboard against an account that does not exist.
    if (!created.ok || typeof created.json.id !== 'string') {
      return res.status(502).json({ message: 'Could not create the Stripe account.', detail: created.json.error ?? null })
    }
    accountId = created.json.id
    await persistProjection(sellerService, seller, created.json)
  }

  const link = await stripeV2('/v2/core/account_links', key, {
    method: 'POST',
    body: {
      account: accountId,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          configurations: ['merchant'],
          // Server-owned, never caller-supplied — these are redirect targets.
          refresh_url: `${SITE_URL}/sell/pagos`,
          return_url: `${SITE_URL}/sell/pagos`,
        },
      },
    },
  })
  if (!link.ok || typeof link.json.url !== 'string') {
    return res.status(502).json({ message: 'Could not start Stripe onboarding.', detail: link.json.error ?? null })
  }

  return res.json({ account_id: accountId, onboarding_url: link.json.url, expires_at: link.json.expires_at ?? null })
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const resolved = await resolveSeller(req)
  if ('error' in resolved) return res.status(resolved.error.status).json({ message: resolved.error.message })
  const { seller, sellerService } = resolved

  const plan = planStripeOnboarding(seller)
  if (plan.action === 'refuse') return res.status(plan.status).json({ message: plan.message, code: plan.code })
  if (plan.action === 'create') {
    // Known-absent is a distinct answer from "unavailable" — say so plainly rather
    // than reporting a not-ready account that does not exist.
    return res.json({ connected: false, ready: false, reason: 'STRIPE_ACCOUNT_ABSENT', requirements: [] })
  }

  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return res.status(500).json({ message: 'Stripe not configured' })

  const account = await stripeV2(
    `/v2/core/accounts/${plan.account_id}?include[0]=configuration.merchant&include[1]=identity&include[2]=requirements`,
    key,
  )
  if (!account.ok) {
    // Unavailable is NOT "not ready": a Stripe outage must not read as a seller who
    // failed onboarding, which is what would make support chase the wrong problem.
    return res.status(503).json({ message: 'Stripe is unavailable; readiness is unknown.', code: 'STRIPE_UNAVAILABLE' })
  }

  const projection = await persistProjection(sellerService, seller, account.json)
  if (!projection) return res.status(502).json({ message: 'Stripe returned an unreadable account.' })

  const readiness = resolveStripeReadiness({
    metadata: { operating_market: 'us', settings: { stripe: projection } },
  })
  return res.json({
    connected: true,
    account_id: projection.account_id,
    ready: readiness.ready,
    reason: readiness.reason,
    requirements: projection.blocking_requirements,
    outstanding_requirements: projection.outstanding_requirements,
  })
}
