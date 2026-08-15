/**
 * Internal service route — read and change a seller's lifecycle status
 * (tenant-lifecycle-admin · S1.2).
 *
 *   GET  /internal/sellers/:id/status  → { status, readable, paused_link_count }
 *   POST /internal/sellers/:id/status  { status: 'active'|'paused'|'deleted', reason }
 *
 * Auth: `internalSecretOk` — the shared definition, which already denies when
 * `MEDUSA_INTERNAL_SECRET` is absent, empty or whitespace. Reused, never restated:
 * fifteen hand-rolled copies of this check were live simultaneously and three failed
 * OPEN, which is why that module exists.
 *
 * ── THIS FILE MAKES NO DECISIONS ──────────────────────────────────────────────
 * Every choice belongs to `planSellerStatusChange`, which is pure and unit-tested.
 * The first cut made those choices inline and got the inputs wrong: it synthesised
 * `every product × every market channel` as "current links", which would have
 * relinked an owned-shop-only product into the marketplace on unpause and published
 * a private catalog — with every unit test green. The shell READS real rows, CALLS
 * the planner, EXECUTES what it returns.
 *
 * ── WHAT THIS ROUTE DOES *NOT* DO ─────────────────────────────────────────────
 * It does not yet stop a checkout. `sellerAdmits` exists and is tested, but the
 * checkout admission seam does not import it until S2.2. A cart created before a
 * pause can still complete. Said plainly here so nobody reads the status column as a
 * money-path guarantee it does not yet provide.
 *
 * ── RESUMABILITY, NOT ATOMICITY ───────────────────────────────────────────────
 * There is no transaction spanning the seller row and the link table, so a partial
 * failure is possible and the design assumes it. Two rules make a retry safe:
 *
 *   · PAUSE writes the ledger BEFORE unlinking, and MERGES it with whatever is
 *     already recorded. A half-finished pause leaves fewer live memberships, so a
 *     naive re-run would record the smaller set and overwrite the record of what the
 *     first attempt already removed — losing it permanently. Union makes it additive.
 *   · UNPAUSE relinks FIRST and clears the ledger AFTERWARDS, keeping every pair it
 *     did not manage to recreate. Clearing first — which the previous revision did —
 *     means a failure halfway leaves the seller active with links missing and no
 *     record of which.
 *
 * The status flip is LAST in both directions. A crash before it leaves a shop dark
 * but reading `active`: visible, and fixed by re-running. The reverse leaves a shop
 * reading `paused` while its products are still on sale.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { internalSecretOk } from '../../../../../lib/internal-auth'
import { decideStatusTransition, parseSellerStatus } from '../../../../../lib/seller-status'
import {
  PAUSED_LINKS_KEY,
  mergeLedgers,
  parsePausedLinks,
  type ChannelLink,
} from '../../../../../lib/seller-channel-ledger'
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

const PAGE = 200

type ProductRow = { id: string; sales_channels?: Array<{ id?: string } | null> | null }

/** Drain a paginated graph query. A partial read here would leave part of a catalog for sale. */
async function drain<T>(
  query: { graph: (q: unknown) => Promise<{ data: T[] }> },
  spec: { entity: string; fields: string[]; filters: unknown },
): Promise<T[]> {
  const rows: T[] = []
  for (let skip = 0; ; skip += PAGE) {
    const { data } = await query.graph({ ...spec, pagination: { take: PAGE, skip } })
    const page = data ?? []
    rows.push(...page)
    if (page.length < PAGE) return rows
  }
}

/**
 * The seller's products that STILL EXIST, and their REAL channel memberships.
 *
 * `existingProductIds` comes from the returned PRODUCT rows, not from the ownership
 * links: a dangling or soft-deleted product still has a `seller_product` row, and
 * treating it as existing would make a restore attempt `link.create` against a
 * product that is gone instead of reporting it missing.
 */
async function readSellerCatalog(
  req: MedusaRequest,
  sellerId: string,
): Promise<{ productIds: Set<string>; links: ChannelLink[] }> {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const owned = await drain<{ product_id?: string }>(query, {
    entity: 'seller_product',
    fields: ['product_id'],
    filters: { seller_id: sellerId },
  })
  const ownedIds = owned
    .map((row) => row.product_id)
    .filter((id): id is string => typeof id === 'string')
  if (ownedIds.length === 0) return { productIds: new Set(), links: [] }

  const products = await drain<ProductRow>(query, {
    entity: 'product',
    fields: ['id', 'sales_channels.id'],
    filters: { id: ownedIds },
  })

  const productIds = new Set(products.map((product) => product.id))
  const links: ChannelLink[] = []
  for (const product of products) {
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
  const ledger = parsePausedLinks(seller.metadata)
  // An unreadable status is reported as such, never smoothed into 'active'.
  res.json({
    status,
    readable: status !== null,
    paused_link_count: ledger.links.length,
    unreadable_ledger_entries: ledger.dropped,
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

  // Refuse BEFORE touching the catalog. An invalid target or a no-op needs no graph
  // query, and reading one first turns a 400 into a 500 whenever the catalog read
  // fails — reporting a transient outage as the caller's mistake.
  const early = decideStatusTransition((seller as { status?: unknown }).status, body.status)
  if (!early.ok) {
    return res.status(early.reason === 'no_change' ? 409 : 400).json({
      message: early.message,
      reason: early.reason,
    })
  }

  const { productIds, links } = await readSellerCatalog(req, id)

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
  /**
   * The link payload shape.
   *
   * `Modules.PRODUCT` / `Modules.SALES_CHANNEL`, NOT the invented `productService` /
   * `salesChannelService` keys the first revision used. Those threw
   * "Module to type productService and salesChannelService … was not found" on every
   * single unlink — and only a LIVE run surfaced it, because the pure planner is
   * correct and every unit test passes against it. The working idiom is in
   * `internal/fix-fulfillment/route.ts`, which links the same way.
   */
  const asLink = (entry: ChannelLink) => ({
    [Modules.PRODUCT]: { product_id: entry.product_id },
    [Modules.SALES_CHANNEL]: { sales_channel_id: entry.sales_channel_id },
  })

  const metadata = { ...((seller.metadata ?? {}) as Record<string, unknown>) }
  const failures: string[] = []
  // paused → deleted keeps its ledger; see the planner. Written as an explicit value
  // for the same merge reason as the clear below.

  // ── PAUSE: record first (merged), then remove. ──────────────────────────────
  if (plan.unlink.length > 0) {
    metadata[PAUSED_LINKS_KEY] = plan.ledgerAfter ?? []
    await sellerService.updateSellers({ id, metadata } as never)
    for (const entry of plan.unlink) {
      try {
        await link.dismiss(asLink(entry))
      } catch (error) {
        failures.push(`unlink ${entry.product_id}→${entry.sales_channel_id}: ${(error as Error).message}`)
      }
    }
  }

  // ── UNPAUSE: recreate first, keep whatever did not make it. ─────────────────
  if (plan.relink.length > 0 || plan.transition.to === 'active') {
    const unrestored: ChannelLink[] = [...plan.missingProducts]
    for (const entry of plan.relink) {
      try {
        await link.create(asLink(entry))
      } catch (error) {
        failures.push(`relink ${entry.product_id}→${entry.sales_channel_id}: ${(error as Error).message}`)
        unrestored.push(entry)
      }
    }
    // Clear ONLY when nothing is outstanding. A ledger cleared over an un-recreated
    // link is unrecoverable; keeping it makes the next run finish the job.
    //
    // NULL, not `delete`. Verified live: a complete restore left `paused_link_count: 2`
    // because `updateSellers` MERGES the metadata blob rather than replacing it, so a
    // locally-deleted key simply is not in the patch and the stored value survives.
    // Writing an explicit null clears it under either semantic, and
    // `parsePausedLinks` already reads null as an empty ledger.
    //
    // Why it matters: a stale ledger would RE-LINK, on some later unpause, pairs that
    // were legitimately unlinked in between — publishing products nobody asked to
    // publish, which is the exact failure D4 exists to prevent.
    if (unrestored.length === 0 && plan.unreadableLedgerEntries === 0) {
      metadata[PAUSED_LINKS_KEY] = null
    } else {
      metadata[PAUSED_LINKS_KEY] = mergeLedgers(unrestored, [])
    }
    await sellerService.updateSellers({ id, metadata } as never)
  } else if (plan.unlink.length === 0) {
    // paused → deleted: no link work, but the ledger must persist as the planner said.
    metadata[PAUSED_LINKS_KEY] = plan.ledgerAfter
    await sellerService.updateSellers({ id, metadata } as never)
  }

  // ── THE STATUS FLIPS ONLY IF THE WORK IT DESCRIBES ACTUALLY HAPPENED ────────
  //
  // A live run exposed this: every unlink failed on a bad module key, and the status
  // flipped to `paused` anyway — a shop reading "paused" while its products were
  // still in the catalog, which is precisely the lying-admin failure this epic exists
  // to prevent. The header promised the opposite ordering guarantee and the code did
  // not implement it.
  //
  // A pause whose unlinks ALL failed did nothing, so it must not claim the state. A
  // PARTIAL failure still flips — the shop is partly dark, the ledger holds what was
  // recorded, and re-running finishes the job — but it reports `complete: false`.
  const attempted = plan.unlink.length + plan.relink.length
  const allWorkFailed = attempted > 0 && failures.length === attempted
  if (!allWorkFailed) {
    await sellerService.updateSellers({ id, status: plan.transition.to } as never)
  }

  const complete = plan.complete && failures.length === 0
  res.json({
    ok: true,
    from: plan.transition.from,
    // The status the seller ACTUALLY holds now — not the requested one. Reporting the
    // target after a refused flip would be the same lie one field over.
    to: allWorkFailed ? plan.transition.from : plan.transition.to,
    status_changed: !allWorkFailed,
    reason,
    unlinked: plan.unlink.length - failures.filter((f) => f.startsWith('unlink')).length,
    restored: plan.relink.length - failures.filter((f) => f.startsWith('relink')).length,
    already_linked: plan.alreadyLinked.length,
    missing_products: plan.missingProducts.map((entry) => entry.product_id),
    unreadable_ledger_entries: plan.unreadableLedgerEntries,
    // Anything short of a full replay says so. The ledger keeps the remainder, so
    // re-running this route finishes the job rather than starting a new one.
    complete,
    ...(failures.length ? { failures } : {}),
  })
}
