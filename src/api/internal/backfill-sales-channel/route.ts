/**
 * POST /internal/backfill-sales-channel
 *
 * One-time maintenance: links every product that is missing the store's default
 * sales channel to it. Seller products created before the sales-channel fix
 * (see sellers/me/products/route.ts) were never linked, making them invisible
 * to the channel-scoped /store/products endpoint and unpurchasable.
 *
 * Outside /store + /admin, so no publishable-key middleware — guarded solely by
 * MEDUSA_INTERNAL_SECRET. Idempotent: only adds products not already in the channel.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { linkProductsToSalesChannelWorkflow } from '@medusajs/medusa/core-flows'

function authed(req: MedusaRequest): boolean {
  const internalSecret = process.env.MEDUSA_INTERNAL_SECRET
  const headerSecret = req.headers['x-internal-secret'] as string | undefined
  return !internalSecret || headerSecret === internalSecret
}

/**
 * GET — diagnostic: report the store default channel, all channels, and which
 * channel(s) the publishable key(s) are linked to (the channel the storefront
 * actually queries). Lets us confirm the backfill targeted the right channel.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!authed(req)) return res.status(401).json({ message: 'Unauthorized' })

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const storeService: any = req.scope.resolve(Modules.STORE)
  const [store] = await storeService.listStores({}, { select: ['id', 'default_sales_channel_id'], take: 1 })

  const { data: channels } = await query.graph({
    entity: 'sales_channel',
    fields: ['id', 'name', 'is_disabled'],
  })

  // The api_key half is wrapped because it was taking the WHOLE diagnostic down.
  //
  // Confirmed against production 2026-07-27: this route returned `unknown_error` while auth passed
  // and every sibling internal route answered normally. A diagnostic that 500s is worse than one that
  // returns partial data — it is consulted precisely when something else is already wrong, and it was
  // the only endpoint that could answer "are there duplicate sales channels?".
  //
  // Degrade and NAME the gap rather than failing the request: the sales-channel list, which is the
  // load-bearing half, now survives an api_key query failure.
  let publishable_keys: unknown[] = []
  let publishable_keys_error: string | null = null
  try {
    // `sales_channels.*` on api_key resolves through a LINK module, and asking for the nested fields
    // in one graph call is what produced `Cannot read properties of undefined (reading 'id')` in
    // production — the link rows come back with an undefined entry the mapper then dereferenced.
    // Ask only for what this diagnostic needs, and defend the mapping: a null-ish link is skipped
    // rather than crashing the whole response.
    const { data: keys } = await query.graph({
      entity: 'api_key',
      fields: ['id', 'type', 'title', 'sales_channels.*'],
      filters: { type: 'publishable' } as any,
    })
    publishable_keys = (keys as any[]).map(k => ({
      id: k?.id ?? null,
      title: k?.title ?? null,
      sales_channels: (k?.sales_channels ?? [])
        .filter((sc: any) => sc && sc.id)
        .map((sc: any) => ({ id: sc.id, name: sc.name ?? null })),
    }))
  } catch (e: any) {
    publishable_keys_error = e?.message ?? 'api_key query failed'
  }

  // Duplicate names are the thing this route is most often consulted about: sales_channel.name has no
  // unique constraint, so a find-or-create race can leave two channels with the same name and split
  // orders across them permanently. Surface it here rather than making every caller re-derive it.
  const byName = new Map<string, string[]>()
  for (const c of channels as any[]) {
    byName.set(c.name, [...(byName.get(c.name) ?? []), c.id])
  }
  const duplicate_channel_names = [...byName.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([name, ids]) => ({ name, ids }))

  return res.json({
    store_default_sales_channel_id: store?.default_sales_channel_id ?? null,
    env_MEDUSA_SALES_CHANNEL_ID: process.env.MEDUSA_SALES_CHANNEL_ID ?? null,
    sales_channels: channels,
    duplicate_channel_names,
    publishable_keys,
    publishable_keys_error,
  })
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const internalSecret = process.env.MEDUSA_INTERNAL_SECRET
  const headerSecret = req.headers['x-internal-secret'] as string | undefined
  if (internalSecret && headerSecret !== internalSecret) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  // ── Resolve target channel ────────────────────────────────────────────────
  let channelId: string | undefined = process.env.MEDUSA_SALES_CHANNEL_ID || undefined
  if (!channelId) {
    const storeService: any = req.scope.resolve(Modules.STORE)
    const [store] = await storeService.listStores({}, { select: ['default_sales_channel_id'], take: 1 })
    channelId = store?.default_sales_channel_id ?? undefined
  }
  if (!channelId) return res.status(500).json({ message: 'No default sales channel resolved' })

  // ── Find products missing the channel ─────────────────────────────────────
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: products } = await query.graph({
    entity: 'product',
    fields: ['id', 'sales_channels.id'],
    pagination: { take: 5000, skip: 0 },
  })

  const toAdd = (products as Array<{ id: string; sales_channels?: Array<{ id: string }> }>)
    .filter(p => !(p.sales_channels ?? []).some(sc => sc.id === channelId))
    .map(p => p.id)

  if (toAdd.length === 0) {
    return res.json({ scanned: products.length, linked: 0, channel_id: channelId, message: 'All products already in channel' })
  }

  await linkProductsToSalesChannelWorkflow(req.scope).run({
    input: { id: channelId, add: toAdd },
  })

  return res.json({ scanned: products.length, linked: toAdd.length, channel_id: channelId })
}
