/**
 * Internal service route — read and change a seller's lifecycle status
 * (tenant-lifecycle-admin · S1.2).
 *
 *   GET  /internal/sellers/:id/status  → { status, paused_link_count }
 *   POST /internal/sellers/:id/status  { status: 'active'|'paused'|'deleted', reason }
 *        → { ok, from, to, unlinked?, restored?, incomplete? }
 *
 * Auth: `internalSecretOk` — the shared definition, which already denies when
 * `MEDUSA_INTERNAL_SECRET` is absent. Reused rather than restated: fifteen hand-rolled
 * copies of this check were live simultaneously and three of them failed OPEN, which
 * is why the shared one exists. Never re-derive the polarity at a call site.
 *
 * ── VALIDATE, THEN CLAIM, THEN APPLY ──────────────────────────────────────────
 * Every decision is made by `decideStatusTransition` BEFORE a single write. The
 * owned-shop epic shipped a defect where publication validation ran *after* the
 * title/image writes, so a rejected request persisted half of itself and still
 * returned an error — and asserting the status code alone would not have caught it,
 * because the broken code returned the right code too. Here the pure decision is
 * hoisted above every mutation, so a partial apply is structurally impossible rather
 * than merely unlikely.
 *
 * ── WHY THE STATUS WRITE COMES LAST ───────────────────────────────────────────
 * Unlink first, then flip the status. If the process dies between them the shop is
 * dark but still reads `active` — visible in the admin as an inconsistency, and
 * re-running the pause fixes it. The other order would leave a shop reading `paused`
 * while its products are still on sale, which is the failure mode this whole epic
 * exists to prevent: an admin that lies about what the API is doing.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { internalSecretOk } from '../../../../../lib/internal-auth'
import {
  decideStatusTransition,
  parseSellerStatus,
  transitionRelinks,
  transitionUnlinks,
} from '../../../../../lib/seller-status'
import {
  PAUSED_LINKS_KEY,
  buildPausedLinks,
  planRestore,
  readPausedLinks,
  restoreIsComplete,
  type ChannelLink,
} from '../../../../../lib/seller-channel-ledger'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'

/** Every market sales channel this deployment knows about. */
function marketChannelIds(): string[] {
  return [
    process.env.MEDUSA_SALES_CHANNEL_ID,
    process.env.MEDUSA_MX_OPERATING_CHANNEL_ID,
    process.env.MEDUSA_US_MARKETPLACE_CHANNEL_ID,
  ].filter((id): id is string => typeof id === 'string' && id.trim() !== '')
}

/** The seller's product ids, via the module link — never a direct DB read. */
async function sellerProductIds(req: MedusaRequest, sellerId: string): Promise<string[]> {
  const remoteQuery = req.scope.resolve('remoteQuery') as (q: unknown) => Promise<unknown>
  const query = (req.scope.resolve('query') as {
    graph: (q: unknown) => Promise<{ data: Array<{ product_id?: string }> }>
  })
  void remoteQuery
  const { data } = await query.graph({
    entity: 'seller_product',
    fields: ['product_id'],
    filters: { seller_id: sellerId },
  })
  return data.map((row) => row.product_id).filter((id): id is string => typeof id === 'string')
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

  // ── DECIDE FIRST. Nothing below this line has written anything yet. ──────────
  const decision = decideStatusTransition((seller as { status?: unknown }).status, body.status)
  if (!decision.ok) {
    const status = decision.reason === 'no_change' ? 409 : 400
    return res.status(status).json({ message: decision.message, reason: decision.reason })
  }
  const { transition } = decision

  const channels = marketChannelIds()
  if (channels.length === 0) {
    // No configured channels means we cannot make a shop dark. Refusing is the only
    // honest answer: flipping the status alone would report a pause that did not
    // happen, which is exactly the lying-admin failure this epic exists to prevent.
    return res.status(503).json({ message: 'No market sales channels are configured.' })
  }

  const link = req.scope.resolve('link') as {
    dismiss: (input: unknown) => Promise<unknown>
    create: (input: unknown) => Promise<unknown>
  }
  const productIds = await sellerProductIds(req, id)

  let unlinked: number | undefined
  let restored: number | undefined
  let incomplete = false
  let metadataPatch: Record<string, unknown> = { ...((seller.metadata ?? {}) as Record<string, unknown>) }

  if (transitionUnlinks(transition)) {
    // Record BEFORE removing — a ledger written after the unlink would describe a
    // world that no longer exists if the process died in between.
    const current: ChannelLink[] = productIds.flatMap((product_id) =>
      channels.map((sales_channel_id) => ({ product_id, sales_channel_id })),
    )
    const ledger = buildPausedLinks(current)
    metadataPatch = { ...metadataPatch, [PAUSED_LINKS_KEY]: ledger }
    await sellerService.updateSellers({ id, metadata: metadataPatch } as never)

    for (const entry of ledger) {
      await link.dismiss({
        productService: { product_id: entry.product_id },
        salesChannelService: { sales_channel_id: entry.sales_channel_id },
      })
    }
    unlinked = ledger.length
  }

  if (transitionRelinks(transition)) {
    const ledger = readPausedLinks(seller.metadata)
    const existing = new Set(productIds)
    // Plan against what is true NOW: products may have been deleted, and links may
    // have been recreated, while the shop was paused.
    const plan = planRestore(ledger, [], existing)
    for (const entry of plan.restore) {
      await link.create({
        productService: { product_id: entry.product_id },
        salesChannelService: { sales_channel_id: entry.sales_channel_id },
      })
    }
    restored = plan.restore.length
    incomplete = !restoreIsComplete(plan)
    // Clear the ledger only after replaying it — a cleared ledger with an
    // un-replayed link is unrecoverable.
    const { [PAUSED_LINKS_KEY]: _cleared, ...rest } = metadataPatch
    metadataPatch = rest
    await sellerService.updateSellers({ id, metadata: metadataPatch } as never)
  }

  // Status LAST — see the header. A crash before this leaves the shop dark but
  // reading active, which is visible and re-runnable; the reverse is not.
  await sellerService.updateSellers({ id, status: transition.to } as never)

  res.json({
    ok: true,
    from: transition.from,
    to: transition.to,
    reason,
    ...(unlinked !== undefined ? { unlinked } : {}),
    ...(restored !== undefined ? { restored } : {}),
    // A restore that could not replay everything reports INCOMPLETE, never success.
    ...(incomplete ? { incomplete: true } : {}),
  })
}
