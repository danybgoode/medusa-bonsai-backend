/**
 * Internal service route — read and change a seller's lifecycle status
 * (tenant-lifecycle-admin · S1.2).
 *
 *   GET  /internal/sellers/:id/status  → { status, readable, paused_link_count }
 *   POST /internal/sellers/:id/status  { status: 'active'|'paused'|'deleted', reason }
 *        → { ok, from, to, unlinked?, restored?, already_linked?, missing_products?, complete }
 *
 * Auth: `internalSecretOk` — the shared definition, which already denies when
 * `MEDUSA_INTERNAL_SECRET` is absent, empty or whitespace. Reused, never restated:
 * fifteen hand-rolled copies of this check were live simultaneously and three failed
 * OPEN, which is why that module exists.
 *
 * ── THIS FILE MAKES NO DECISIONS ──────────────────────────────────────────────
 * Every choice — what to unlink, what to relink, what the ledger becomes, whether
 * the result is complete — belongs to `planSellerStatusChange`, which is pure and
 * unit-tested. The first cut of this route made those choices inline and got the
 * inputs wrong: it synthesised `every product × every market channel` as "current
 * links", which would have relinked an owned-shop-only product into the marketplace
 * on unpause and published a private catalog, with every unit test green. So the
 * shell now does exactly three things: READ real rows, CALL the planner, EXECUTE
 * what it returns.
 *
 * ── ORDER OF EFFECTS ──────────────────────────────────────────────────────────
 * Ledger first, then links, then status. A crash between them leaves a shop dark
 * but still reading `active` — visible in the admin as an inconsistency and fixed by
 * re-running. The reverse order leaves a shop reading `paused` while its products
 * are still on sale, which is the lying-admin failure this epic exists to prevent.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { internalSecretOk } from '../../../../../lib/internal-auth'
import { parseSellerStatus } from '../../../../../lib/seller-status'
import { PAUSED_LINKS_KEY, readPausedLinks, type ChannelLink } from '../../../../../lib/seller-channel-ledger'
import { planSellerStatusChange } from '../../../_utils/seller-status-plan'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'

/** Market sales channels this deployment is configured with. */
export function marketChannelIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    env.MEDUSA_SALES_CHANNEL_ID,
    env.MEDUSA_MX_OPERATING_CHANNEL_ID,
    env.MEDUSA_US_MARKETPLACE_CHANNEL_ID,
  ].filter((id): id is string => typeof id === 'string' && id.trim() !== '')
}

type ProductRow = { id: string; sales_channels?: Array<{ id?: string } | null> | null }

/**
 * The seller's products AND their REAL channel memberships.
 *
 * Reading the memberships rather than assuming them is the whole correctness of the
 * pause/unpause round trip — see the file header.
 */
async function readSellerCatalog(
  req: MedusaRequest,
  sellerId: string,
): Promise<{ productIds: Set<string>; links: ChannelLink[] }> {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const { data: owned } = await query.graph({
    entity: 'seller_product',
    fields: ['product_id'],
    filters: { seller_id: sellerId } as never,
  })
  const productIds = new Set(
    (owned ?? [])
      .map((row: { product_id?: string }) => row.product_id)
      .filter((id: unknown): id is string => typeof id === 'string'),
  )
  if (productIds.size === 0) return { productIds, links: [] }

  const { data: products } = await query.graph({
    entity: 'product',
    fields: ['id', 'sales_channels.id'],
    filters: { id: [...productIds] } as never,
  })

  const links: ChannelLink[] = []
  for (const product of (products ?? []) as ProductRow[]) {
    for (const channel of product.sales_channels ?? []) {
      if (channel?.id) links.push({ product_id: product.id, sales_channel_id: channel.id })
    }
  }
  return { productIds, links }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!internalSecretOk(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { id } = req.params
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ id } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const status = parseSellerStatus((seller as { status?: unknown }).status)
  // An unreadable status is reported as such, never smoothed into 'active'.
  res.json({
    status,
    readable: status !== null,
    paused_link_count: readPausedLinks(seller.metadata).length,
  })
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!internalSecretOk(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { id } = req.params
  const body = (req.body ?? {}) as { status?: unknown; reason?: unknown }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) return res.status(400).json({ message: 'reason is required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ id } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const { productIds, links } = await readSellerCatalog(req, id)

  // ── DECIDE. Nothing below has written anything yet. ─────────────────────────
  const plan = planSellerStatusChange({
    currentStatus: (seller as { status?: unknown }).status,
    targetStatus: body.status,
    metadata: seller.metadata,
    actualLinks: links,
    existingProductIds: productIds,
    marketChannelIds: marketChannelIds(),
  })
  if (!plan.ok) {
    return res.status(plan.httpStatus).json({ message: plan.message, reason: plan.reason })
  }

  const link = req.scope.resolve(ContainerRegistrationKeys.LINK) as {
    dismiss: (input: unknown) => Promise<unknown>
    create: (input: unknown) => Promise<unknown>
  }

  // ── APPLY, in the order the header explains. ────────────────────────────────
  const metadata = { ...((seller.metadata ?? {}) as Record<string, unknown>) }
  if (plan.ledgerAfter === null) delete metadata[PAUSED_LINKS_KEY]
  else metadata[PAUSED_LINKS_KEY] = plan.ledgerAfter
  await sellerService.updateSellers({ id, metadata } as never)

  for (const entry of plan.unlink) {
    await link.dismiss({
      productService: { product_id: entry.product_id },
      salesChannelService: { sales_channel_id: entry.sales_channel_id },
    })
  }
  for (const entry of plan.relink) {
    await link.create({
      productService: { product_id: entry.product_id },
      salesChannelService: { sales_channel_id: entry.sales_channel_id },
    })
  }

  await sellerService.updateSellers({ id, status: plan.transition.to } as never)

  res.json({
    ok: true,
    from: plan.transition.from,
    to: plan.transition.to,
    reason,
    unlinked: plan.unlink.length,
    restored: plan.relink.length,
    already_linked: plan.alreadyLinked.length,
    missing_products: plan.missingProducts.map((entry) => entry.product_id),
    // An incomplete restore says so. The unreplayable remainder stays in the ledger.
    complete: plan.complete,
  })
}
