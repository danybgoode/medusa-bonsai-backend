import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { isEnabled } from '../../../../lib/flags'
import { appendOrderLedger } from '../../../../lib/profit-ledger-write'

/**
 * POST /internal/profit/backfill — replay orders through the profit ledger
 * (profit-analyzer S1 · US-2). Heals any gap: orders placed while
 * `ops.profit_enabled` was OFF, Epic-A-materialized ML orders that predate
 * this epic, or a write point that hiccuped. Safe to re-run any time —
 * every event's dedupe key is deterministic, so replays append nothing new.
 *
 * Body (all optional): { source?: 'mercadolibre' | 'native', limit?: number }
 * — default scans ML-source orders (the sprint doc's stated backfill target;
 * currently zero in prod since `ml.orders_enabled` has never been ON, so the
 * default run is a clean no-op). Auth: `x-internal-secret` (the standard
 * internal-route guard). Gate order: flag → auth → work (LEARNINGS).
 */

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

const MAX_LIMIT = 500

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!(await isEnabled('ops.profit_enabled'))) {
    return res.status(404).json({ message: 'Not found' })
  }
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const body = (req.body ?? {}) as { source?: unknown; limit?: unknown }
  const source = body.source === 'native' ? 'native' : 'mercadolibre'
  const limit = Math.min(
    MAX_LIMIT,
    typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0 ? body.limit : MAX_LIMIT,
  )

  // Candidate order ids by source. ML orders carry metadata.source =
  // 'mercadolibre' (stamped by materializeMlOrder); metadata filtering isn't
  // supported by the graph read, so filter in memory over a bounded window.
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: 'order',
    fields: ['id', 'metadata'],
    filters: {},
    pagination: { take: limit, order: { created_at: 'DESC' } },
  })
  const orders = ((data ?? []) as Array<{ id: string; metadata?: Record<string, unknown> | null }>)
    .filter((o) => {
      const isMl = o.metadata?.source === 'mercadolibre'
      return source === 'mercadolibre' ? isMl : !isMl
    })

  let appended = 0
  let skipped = 0
  let failed = 0
  for (const order of orders) {
    const result = await appendOrderLedger(req.scope, order.id)
    if (!result) { failed += 1; continue }
    appended += result.appended
    skipped += result.skipped
  }

  return res.json({ source, scanned: orders.length, appended, skipped, failed })
}
