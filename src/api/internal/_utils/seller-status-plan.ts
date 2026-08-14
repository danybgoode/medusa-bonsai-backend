/**
 * seller-status-plan.ts — the WHOLE decision for a seller status change, as one pure
 * function (tenant-lifecycle-admin · S1.2).
 *
 * ── WHY THIS EXISTS, AND WHY IT IS THE WHOLE DECISION ─────────────────────────
 * The first cut of this feature put the transition rules and the link ledger in
 * well-tested pure modules, and then wrote an untested route that fed them the wrong
 * data: it synthesised `every product × every market channel` as "the seller's
 * current links". That fabricated membership an owned-shop-only product never had,
 * so unpausing would have CREATED a marketplace link and published a private
 * catalog — the precise failure the ledger exists to prevent, reintroduced one layer
 * up, with every unit test green.
 *
 * The lesson is not "add a test for that line". It is that a pure core is only as
 * true as its inputs, so the input-gathering has to be the ONLY thing left in the
 * shell. This function now owns every decision — what to unlink, what to relink,
 * what the ledger becomes, and whether the result is complete — and the route does
 * nothing but read rows, call this, and execute the returned operations.
 *
 * Pure: no container, no database, no clock, no env.
 */
import {
  decideStatusTransition,
  transitionRelinks,
  transitionUnlinks,
  type SellerStatus,
  type SellerStatusTransition,
} from '../../../lib/seller-status'
import {
  buildPausedLinks,
  planRestore,
  readPausedLinks,
  restoreIsComplete,
  type ChannelLink,
} from '../../../lib/seller-channel-ledger'

export type StatusPlanRefusal = {
  ok: false
  httpStatus: 400 | 409 | 503
  reason: string
  message: string
}

export type StatusPlanAccepted = {
  ok: true
  transition: SellerStatusTransition
  /** Links to remove, straight from the seller's ACTUAL memberships. */
  unlink: ChannelLink[]
  /** Links to recreate, from the ledger, minus anything already linked or gone. */
  relink: ChannelLink[]
  /** Recorded pairs that are already linked — reported, never re-created. */
  alreadyLinked: ChannelLink[]
  /** Recorded pairs whose product no longer exists. */
  missingProducts: ChannelLink[]
  /**
   * What `metadata.paused_channel_links` must hold afterwards.
   * `null` means remove the key entirely.
   */
  ledgerAfter: ChannelLink[] | null
  /**
   * False when a restore could not replay everything. The route reports this and
   * KEEPS the unreplayed remainder in the ledger — clearing it would make the
   * missing links unrecoverable, which is worse than the pause itself.
   */
  complete: boolean
}

export type StatusPlan = StatusPlanRefusal | StatusPlanAccepted

export type StatusPlanInput = {
  currentStatus: unknown
  targetStatus: unknown
  /** `seller.metadata`, unparsed. */
  metadata: unknown
  /** The seller's ACTUAL product↔sales-channel memberships, as read from Medusa. */
  actualLinks: readonly ChannelLink[]
  /** Ids of products that still exist, for deciding what a restore can replay. */
  existingProductIds: ReadonlySet<string>
  /** Market channels this deployment is configured with. */
  marketChannelIds: readonly string[]
}

export function planSellerStatusChange(input: StatusPlanInput): StatusPlan {
  const decision = decideStatusTransition(input.currentStatus, input.targetStatus)
  if (!decision.ok) {
    return {
      ok: false,
      httpStatus: decision.reason === 'no_change' ? 409 : 400,
      reason: decision.reason,
      message: decision.message,
    }
  }
  const { transition } = decision
  const unlinks = transitionUnlinks(transition)
  const relinks = transitionRelinks(transition)

  // Channels are only needed to make a shop DARK. Requiring them for
  // `paused → deleted` (already dark) or for a ledger-driven restore would refuse a
  // transition that does not consult them — a guard that rejects correct input.
  if (unlinks && input.marketChannelIds.length === 0) {
    return {
      ok: false,
      httpStatus: 503,
      reason: 'no_market_channels',
      message: 'No market sales channels are configured, so a shop cannot be made dark.',
    }
  }

  if (unlinks) {
    // ONLY real memberships, narrowed to the market channels. A pair the seller does
    // not actually have is never recorded, so it can never be "restored" into
    // existence later.
    const markets = new Set(input.marketChannelIds)
    const unlink = buildPausedLinks(
      input.actualLinks.filter((link) => markets.has(link.sales_channel_id)),
    )
    return {
      ok: true,
      transition,
      unlink,
      relink: [],
      alreadyLinked: [],
      missingProducts: [],
      ledgerAfter: unlink,
      complete: true,
    }
  }

  if (relinks) {
    const ledger = readPausedLinks(input.metadata)
    const restore = planRestore(ledger, input.actualLinks, input.existingProductIds)
    const complete = restoreIsComplete(restore)
    return {
      ok: true,
      transition,
      unlink: [],
      relink: restore.restore,
      alreadyLinked: restore.alreadyLinked,
      missingProducts: restore.missingProducts,
      // Keep the unreplayable remainder so a later retry (or a human) can act on it.
      // Clearing a ledger whose links were never recreated destroys the only record
      // of what the shop is missing.
      ledgerAfter: complete ? null : restore.missingProducts,
      complete,
    }
  }

  // A transition that neither unlinks nor relinks (paused → deleted): the products
  // are already out, and the ledger stays exactly as it is so a later restore — if
  // the product owner ever asks for one — still has its record.
  return {
    ok: true,
    transition,
    unlink: [],
    relink: [],
    alreadyLinked: [],
    missingProducts: [],
    ledgerAfter: readPausedLinks(input.metadata),
    complete: true,
  }
}

/** The statuses a caller may name. Exported so the route's 400 can list them. */
export type { SellerStatus }
