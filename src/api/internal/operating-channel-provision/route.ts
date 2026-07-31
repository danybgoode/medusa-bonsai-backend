/**
 * /internal/operating-channel-provision — create the MX operating channel and give
 * it D5's stock-location links, from INSIDE the VPC.
 *
 *   GET  — fully read-only dry-run report.
 *   POST — applies. `dry_run` defaults to TRUE; pass `{ "dry_run": false }` to write.
 *
 * WHY A ROUTE AND NOT THE SCRIPT: production's Cloud SQL instance has no public ip
 * (`ipv4Enabled: false`, DATABASE_URL → 10.7.0.3), so `npx medusa exec` from any
 * machine outside the VPC times out acquiring a connection. Sprint 1 shipped the
 * script and handed over that command; it was unrunnable. The decision logic lives
 * in `_utils/operating-channel-provision.ts` and is shared, so this route and the
 * script cannot drift.
 *
 * D10 ORDERING, non-negotiable: the allow-list entry (`registryOperatingChannelIds`
 * inside `protectedSalesChannelIds`) must already be DEPLOYED before this creates
 * anything, or the new channel exists for a window with nothing protecting it from
 * `cleanup-default-data.ts`. That shipped in PR 128, which is live.
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET, and a MISSING secret
 * DENIES (src/lib/internal-auth.ts). This route creates a production Sales Channel.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { DEFAULT_MARKET, requireMarket, type MarketCode } from '../../../lib/markets'
import { internalSecretOk } from '../../../lib/internal-auth'
import { provisionOperatingChannel } from '../_utils/operating-channel-provision'

function resolveMarket(raw: unknown): { market: MarketCode } | { error: string } {
  try {
    return { market: requireMarket(raw ?? DEFAULT_MARKET).code }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!internalSecretOk(req)) return res.status(401).json({ message: 'Unauthorized' })

  const resolved = resolveMarket((req.query as Record<string, string>)?.market)
  if ('error' in resolved) return res.status(400).json({ message: resolved.error })

  const report = await provisionOperatingChannel(req.scope, {
    market: resolved.market,
    apply: false,
    env: process.env,
  })
  // Never a confident empty result: a blocked report is a 503 that SAYS why, not a
  // 200 whose zeroes read like a clean bill of health.
  return res.status(report.blocked_by.length > 0 ? 503 : 200).json(report)
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!internalSecretOk(req)) return res.status(401).json({ message: 'Unauthorized' })

  const body = (req.body ?? {}) as { market?: string; dry_run?: boolean }
  const resolved = resolveMarket(body.market)
  if ('error' in resolved) return res.status(400).json({ message: resolved.error })

  // Safe by default — the same posture as /internal/prune-sales-channels.
  const dryRun = body.dry_run !== false

  const report = await provisionOperatingChannel(req.scope, {
    market: resolved.market,
    apply: !dryRun,
    env: process.env,
  })
  return res.status(report.blocked_by.length > 0 ? 422 : 200).json(report)
}
