/**
 * POST /internal/prune-sales-channels
 *
 * Deletes all duplicate / unused sales channels, keeping only:
 *   1. The store's default_sales_channel_id
 *   2. The channel referenced by MEDUSA_SALES_CHANNEL_ID env var
 *
 * Safe: dry_run=true (default) only reports what would be deleted.
 * Pass { dry_run: false } to actually delete.
 *
 * Auth: x-internal-secret header.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'

function authed(req: MedusaRequest): boolean {
  const secret = process.env.MEDUSA_INTERNAL_SECRET
  const provided = req.headers['x-internal-secret'] as string | undefined
  return !secret || provided === secret
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!authed(req)) return res.status(401).json({ message: 'Unauthorized' })

  const body = (req.body ?? {}) as { dry_run?: boolean }
  const dryRun = body.dry_run !== false // default true — safe by default

  const storeService: any = req.scope.resolve(Modules.STORE)
  const salesChannelService: any = req.scope.resolve(Modules.SALES_CHANNEL)

  // Resolve the two channels we must keep
  const [store] = await storeService.listStores(
    {}, { select: ['id', 'default_sales_channel_id'], take: 1 },
  )
  const keepIds = new Set<string>([
    store?.default_sales_channel_id,
    process.env.MEDUSA_SALES_CHANNEL_ID ?? '',
  ].filter(Boolean))

  // List all channels
  const all: any[] = await salesChannelService.listSalesChannels(
    {}, { select: ['id', 'name', 'is_disabled'], take: 500 },
  ).catch(() => [] as any[])

  const toDelete = all.filter(sc => !keepIds.has(sc.id))
  const toKeep   = all.filter(sc =>  keepIds.has(sc.id))

  if (dryRun) {
    return res.json({
      dry_run: true,
      keep:   toKeep.map(sc => ({ id: sc.id, name: sc.name })),
      delete: toDelete.map(sc => ({ id: sc.id, name: sc.name })),
      total_channels: all.length,
      would_delete: toDelete.length,
    })
  }

  // Delete in batches of 10 to avoid overwhelming the DB
  const deleted: string[] = []
  const errors: string[]  = []

  for (let i = 0; i < toDelete.length; i += 10) {
    const batch = toDelete.slice(i, i + 10)
    await Promise.all(
      batch.map(sc =>
        salesChannelService.deleteSalesChannels(sc.id)
          .then(() => deleted.push(sc.id))
          .catch((e: unknown) => errors.push(`${sc.id}: ${e instanceof Error ? e.message : String(e)}`))
      )
    )
  }

  console.log(`[prune-sales-channels] deleted ${deleted.length}, errors ${errors.length}`)

  return res.json({
    dry_run: false,
    kept:    toKeep.map(sc => ({ id: sc.id, name: sc.name })),
    deleted: deleted.length,
    errors,
    total_before: all.length,
    total_after:  all.length - deleted.length,
  })
}
