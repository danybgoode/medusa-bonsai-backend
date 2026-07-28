/**
 * POST /internal/prune-api-keys
 *
 * Deletes the orphan publishable API keys left behind by repeated
 * `initial-data-seed` runs, keeping the key(s) the storefront actually uses.
 * Deleting a key also removes its `publishable_api_key_sales_channel` rows —
 * including the DANGLING ones pointing at already-deleted sales channels —
 * because `deleteApiKeysWorkflow` runs `removeRemoteLinkStep` keyed on
 * `publishable_key_id`. That is why this one action fixes both the orphan-key
 * count and the dangling-link count.
 *
 * The decision is pure and lives in `_utils/api-key-cleanup.ts`; this route is
 * the I/O shell. See that file for the safety contract and every refusal.
 *
 * Safe by default: `dry_run` is true unless explicitly `false` — the same
 * posture as `/internal/prune-sales-channels`. A dry run is FULLY read-only.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { deleteApiKeysWorkflow } from '@medusajs/medusa/core-flows'
import { planApiKeyCleanup } from '../_utils/api-key-cleanup'

function authed(req: MedusaRequest): boolean {
  const secret = process.env.MEDUSA_INTERNAL_SECRET
  const provided = req.headers['x-internal-secret'] as string | undefined
  return !secret || provided === secret
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!authed(req)) return res.status(401).json({ message: 'Unauthorized' })

  const body = (req.body ?? {}) as { dry_run?: boolean }
  const dryRun = body.dry_run !== false // default true — safe by default

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  // `sales_channels.*` (the wildcard, not named subfields) is what the sibling
  // diagnostic uses — the named-field form is what crashed production. `token`
  // is selected so the plan can recognise the storefront's own credential;
  // publishable tokens are public by design, and only a prefix is echoed back.
  let rows: unknown
  try {
    const { data } = await query.graph({
      entity: 'api_key',
      fields: ['id', 'type', 'title', 'token', 'sales_channels.*'],
      filters: { type: 'publishable' } as any,
    })
    rows = data
  } catch (e: any) {
    // A script that exits green having run nothing reads as a passing gate.
    // Fail loudly instead — this one deletes credentials.
    return res.status(502).json({
      message: `api_key query failed: ${e?.message ?? 'unknown error'}`,
      applied: false,
    })
  }

  const plan = planApiKeyCleanup(rows, {
    storefrontToken: process.env.MEDUSA_PUBLISHABLE_KEY ?? null,
  })

  if (plan.refuse) {
    return res.status(409).json({ dry_run: dryRun, applied: false, ...plan })
  }
  if (dryRun) {
    return res.json({ dry_run: true, applied: false, ...plan })
  }
  if (plan.delete.length === 0) {
    return res.json({ dry_run: false, applied: false, message: 'nothing to delete', ...plan })
  }

  const ids = plan.delete.map(k => k.id)
  await deleteApiKeysWorkflow(req.scope).run({ input: { ids } })

  // Re-read rather than reporting what we intended to do — a delete that
  // matched nothing must not come back looking like a success (AGENTS → a read
  // is not a claim).
  const { data: after } = await query.graph({
    entity: 'api_key',
    fields: ['id', 'type', 'title', 'token', 'sales_channels.*'],
    filters: { type: 'publishable' } as any,
  })
  const verified = planApiKeyCleanup(after, {
    storefrontToken: process.env.MEDUSA_PUBLISHABLE_KEY ?? null,
  })

  return res.json({
    dry_run: false,
    applied: true,
    deleted: ids.length,
    deleted_ids: ids,
    before: {
      total_keys: plan.total_keys,
      total_live_links: plan.total_live_links,
      total_dangling_links: plan.total_dangling_links,
    },
    after: {
      total_keys: verified.total_keys,
      total_live_links: verified.total_live_links,
      total_dangling_links: verified.total_dangling_links,
      keep: verified.keep,
    },
  })
}
