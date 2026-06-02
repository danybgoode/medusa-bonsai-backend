/**
 * POST /internal/fix-fulfillment
 *
 * Idempotent repair for two issues the diagnostic surfaced:
 *
 *  1. Products have no shipping profile (shipping_profile_id = null) → completeCart
 *     fails "shipping profiles not satisfied". Links every product to the canonical
 *     default shipping profile (the one the seeded options use).
 *
 *  2. The México stock location carries a dangling sales_channel link to a deleted
 *     (pruned) channel → admin /settings/locations crashes ("null is not an object
 *     (o.name)"). Dismisses links to channel ids passed in `dangling_channel_ids`.
 *
 * Body: { dangling_channel_ids?: string[] }   (both steps are safe to re-run)
 * Auth: x-internal-secret header.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { resolveDefaultShippingProfileId } from '../../store/_utils/fulfillment'

function authed(req: MedusaRequest): boolean {
  const secret = process.env.MEDUSA_INTERNAL_SECRET
  const provided = req.headers['x-internal-secret'] as string | undefined
  return !secret || provided === secret
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!authed(req)) return res.status(401).json({ message: 'Unauthorized' })

  const body = (req.body ?? {}) as { dangling_channel_ids?: string[] }
  const query: any = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const link: any = req.scope.resolve(ContainerRegistrationKeys.LINK)
  const report: Record<string, unknown> = {}

  // ── 1. Link products → default shipping profile ───────────────────────────
  const profileId = await resolveDefaultShippingProfileId(req.scope)
  if (!profileId) {
    return res.status(500).json({ message: 'No default shipping profile found' })
  }
  report.shipping_profile_id = profileId

  let linked = 0
  let alreadyLinked = 0
  const linkErrors: string[] = []
  let skip = 0
  // Paginate through all products
  for (;;) {
    const { data: products } = await query.graph({
      entity: 'product',
      fields: ['id', 'shipping_profile.id'],
      pagination: { take: 200, skip },
    })
    if (!products?.length) break
    for (const p of products) {
      if (p.shipping_profile?.id) { alreadyLinked++; continue }
      try {
        await link.create({
          [Modules.PRODUCT]: { product_id: p.id },
          [Modules.FULFILLMENT]: { shipping_profile_id: profileId },
        })
        linked++
      } catch (e) {
        linkErrors.push(`${p.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    skip += products.length
    if (products.length < 200) break
  }
  report.products_linked = linked
  report.products_already_linked = alreadyLinked
  if (linkErrors.length) report.product_link_errors = linkErrors.slice(0, 10)

  // ── 2. Dismiss dangling location ↔ sales_channel links ────────────────────
  const danglingIds = body.dangling_channel_ids ?? []
  const dismissed: string[] = []
  const dismissErrors: string[] = []
  if (danglingIds.length) {
    const stockLocation: any = req.scope.resolve(Modules.STOCK_LOCATION)
    const locations: any[] = await stockLocation
      .listStockLocations({}, { select: ['id'], take: 100 })
      .catch(() => [] as any[])

    for (const loc of locations) {
      for (const channelId of danglingIds) {
        try {
          await link.dismiss({
            [Modules.SALES_CHANNEL]: { sales_channel_id: channelId },
            [Modules.STOCK_LOCATION]: { stock_location_id: loc.id },
          })
          dismissed.push(`${loc.id}↔${channelId}`)
        } catch (e) {
          dismissErrors.push(`${loc.id}↔${channelId}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
  }
  report.channel_links_dismissed = dismissed
  if (dismissErrors.length) report.dismiss_errors = dismissErrors.slice(0, 10)

  return res.json({ ok: true, ...report })
}
