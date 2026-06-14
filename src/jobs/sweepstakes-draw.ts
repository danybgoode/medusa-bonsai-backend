/**
 * Scheduled job: sweepstakes-draw
 *
 * Runs the tenant sweepstakes draw loop from the GCP-hosted Medusa backend.
 * This avoids Vercel Hobby cron limits while keeping the draw implementation in
 * the Next.js app, where the sweepstakes Supabase/email helpers already live.
 *
 * Auth uses MEDUSA_INTERNAL_SECRET, already present on the Cloud Run service,
 * via the x-internal-secret header.
 */

import { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'

const SITE_URL =
  process.env.SITE_URL ??
  process.env.NEXT_PUBLIC_SITE_URL ??
  'https://miyagisanchez.com'

type SweepstakesDrawResponse = {
  ok?: boolean
  scanned?: number
  drawn?: number
  disabled?: boolean
  error?: string
}

export default async function sweepstakesDrawJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const secret = process.env.MEDUSA_INTERNAL_SECRET ?? ''

  if (!secret) {
    logger.warn('[sweepstakes-draw] MEDUSA_INTERNAL_SECRET not set — skipping')
    return
  }

  try {
    const res = await fetch(`${SITE_URL}/api/cron/sweepstakes-draw`, {
      method: 'GET',
      headers: { 'x-internal-secret': secret },
    })
    const body = await res.json().catch(() => ({})) as SweepstakesDrawResponse
    if (!res.ok) {
      logger.error(`[sweepstakes-draw] trigger failed: ${res.status} ${JSON.stringify(body)}`)
      return
    }

    if ((body.drawn ?? 0) > 0) {
      logger.info(`[sweepstakes-draw] ${JSON.stringify(body)}`)
    }
  } catch (e) {
    logger.error(`[sweepstakes-draw] error: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export const config = {
  name: 'sweepstakes-draw',
  // Every 15 min (was `* * * * *` = every minute). The draw is idempotent and only acts when a
  // sweepstakes has actually ended, so minute-precision is unnecessary — a ≤15 min draw latency is
  // fine and this fetches the Vercel `/api/cron/sweepstakes-draw` route ~96×/day instead of ~1,440×
  // (≈ -43K Vercel function invocations/month + the matching Fluid Active CPU). See cost-reduction epic.
  schedule: '*/15 * * * *',
}
