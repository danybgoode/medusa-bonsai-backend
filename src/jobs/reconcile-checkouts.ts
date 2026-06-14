/**
 * Scheduled job: reconcile-checkouts
 *
 * Safety net for the checkout flow — catches carts paid at the provider but
 * never completed into an order (buyer abandoned the redirect AND the provider
 * webhook missed). Runs every 15 minutes on the backend worker (no Vercel cron
 * plan limits — the Hobby plan only allows daily Vercel crons).
 *
 * It triggers the existing frontend route GET /api/cron/reconcile-checkouts,
 * which owns the scan → complete → Supabase mirror → email/Telegram logic
 * (those depend on frontend-only services). Auth uses MEDUSA_INTERNAL_SECRET,
 * already present on the backend, via the x-internal-secret header.
 */

import { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'

const SITE_URL =
  process.env.SITE_URL ??
  process.env.NEXT_PUBLIC_SITE_URL ??
  'https://miyagisanchez.com'

export default async function reconcileCheckoutsJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const secret = process.env.MEDUSA_INTERNAL_SECRET ?? ''

  if (!secret) {
    logger.warn('[reconcile-checkouts] MEDUSA_INTERNAL_SECRET not set — skipping')
    return
  }

  try {
    const res = await fetch(`${SITE_URL}/api/cron/reconcile-checkouts`, {
      method: 'GET',
      headers: { 'x-internal-secret': secret },
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      logger.error(`[reconcile-checkouts] trigger failed: ${res.status} ${JSON.stringify(body)}`)
      return
    }
    const reconciled = (body as { reconciled?: number }).reconciled ?? 0
    if (reconciled > 0) {
      logger.info(`[reconcile-checkouts] ${JSON.stringify(body)}`)
    }
  } catch (e) {
    logger.error(`[reconcile-checkouts] error: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export const config = {
  name: 'reconcile-checkouts',
  // Every 30 min (was */15). Incomplete-cart reconciliation isn't time-critical, so halving the cadence
  // halves this job's fetches to the Vercel /api/cron/reconcile-checkouts route at no UX cost.
  schedule: '*/30 * * * *',
}
