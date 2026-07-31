/**
 * /internal/publishable-key-channel-move — owned-shop-operating-channel epic, S2.1.
 *
 *   GET  — FULLY READ-ONLY dry-run report: every publishable key, its current channel
 *          links, the D5 stock-location graph, and exactly what would change.
 *   POST — applies. `dry_run` defaults to **true** (the `/internal/prune-sales-channels`
 *          posture); pass `{ "dry_run": false }` to actually move the key.
 *
 * A builder NEVER runs the apply. The orchestrator does, after reading the GET
 * (WAYS-OF-WORKING: shared/production mutations are the orchestrator's).
 *
 * ── WHAT IT DOES ───────────────────────────────────────────────────────────────
 * UNLINKS the storefront publishable key from the marketplace channel and LINKS it to
 * the market's OPERATING channel, as one `linkSalesChannelsToApiKeyWorkflow` call
 * carrying both `add` and `remove`. Link rows: **1 → 1**. The planner
 * (`_utils/publishable-key-channel-move.ts`) refuses any outcome that would leave the
 * key holding a number of channels other than one, and its header carries the traced
 * Medusa 2.15.3 mechanism for why — read that before changing anything here.
 *
 * Because the operating channel is a strict SUPERSET of the marketplace channel (D2,
 * established by the S1.4 backfill), `/store/products` and the cart keep serving
 * everything they serve today, plus owned-shop-only products.
 *
 * ── WHY A ROUTE AND NOT A `medusa exec` SCRIPT ─────────────────────────────────
 * Measured 2026-07-31: production's Cloud SQL instance has `ipv4Enabled: false` and a
 * private ip, so `medusa exec` cannot reach it from outside the VPC no matter what
 * credentials it holds. Every production mutation in this repo is an internal HTTP
 * route for that reason. The full finding is in
 * `_utils/operating-channel-provision.ts`'s header.
 *
 * ── D5 IS A PRECONDITION, NOT A FOOTNOTE ───────────────────────────────────────
 * Medusa reserves inventory at order completion against THE CART'S sales channel. The
 * moment this route runs, that channel becomes the operating one. If the operating
 * channel is not linked to every stock location the marketplace channel is, every
 * managed-inventory purchase fails at completion — after payment. So the move REFUSES
 * while any location is missing, and the report shows the graph either way.
 *
 * ── ROLLBACK (D9) ──────────────────────────────────────────────────────────────
 * Two link operations, not a deploy:
 *
 *     POST /internal/publishable-key-channel-move
 *       { "dry_run": false, "market": "mx", "desired_channel": "marketplace" }
 *
 * The key returns to exactly one link row pointing at `MEDUSA_SALES_CHANNEL_ID` and
 * the catalog is byte-identical to today's. Operating-channel product memberships are
 * LEFT IN PLACE — they are inert once the key points elsewhere (D9), and deleting
 * them would throw away the verified backfill.
 *
 * Auth: `x-internal-secret` must match `MEDUSA_INTERNAL_SECRET`, and a MISSING secret
 * DENIES (src/lib/internal-auth.ts). This route repoints the credential the entire
 * storefront authenticates with; "the deploy is misconfigured" is exactly when it
 * must not be open.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { linkSalesChannelsToApiKeyWorkflow } from '@medusajs/medusa/core-flows'
import { internalSecretOk } from '../../../lib/internal-auth'
import { DEFAULT_MARKET, requireMarket, type MarketCode } from '../../../lib/markets'
import {
  resolveMarketplaceChannelForMarket,
  resolveOperatingChannelForMarket,
  type MedusaIdResolution,
} from '../../../lib/market-medusa'
import { locationIdsForChannel, planStockLocationLinks } from '../_utils/stock-location-graph'
import {
  planPublishableKeyChannelMove,
  type KeyChannelMovePlan,
} from '../_utils/publishable-key-channel-move'

function authed(req: MedusaRequest): boolean {
  // Fail CLOSED: a missing MEDUSA_INTERNAL_SECRET denies everyone. One definition,
  // in src/lib/internal-auth.ts — see the incident note there.
  return internalSecretOk(req)
}

/**
 * Which channel the key should end up on. `operating` is the S2.1 move; `marketplace`
 * is D9's rollback. Spelled as a WORD rather than accepting a raw channel id: a
 * caller-supplied id would let a typo point the storefront's only credential at an
 * arbitrary channel, and both legitimate targets are already registry-derived.
 */
type DesiredChannel = 'operating' | 'marketplace'

function readDesiredChannel(raw: unknown): DesiredChannel | null {
  // Absent ⇒ the forward move (`operating`), which is what this route is for.
  // An EMPTY STRING is not absent — it is a caller that meant to say something and
  // said nothing, on a route that rewrites the storefront's channel scope. Refuse it
  // the same way an unrecognised value is refused, rather than silently performing
  // the forward move. (Cross-agent review, claude-opus-4-6.)
  if (raw === undefined || raw === null) return 'operating'
  return raw === 'operating' || raw === 'marketplace' ? raw : null
}

interface StockLocationReport {
  readonly available: boolean
  readonly reason: string | null
  readonly marketplace_location_ids: readonly string[]
  readonly operating_location_ids: readonly string[]
  readonly missing_on_operating: readonly string[]
}

/**
 * Read-only. Returns `available: false` with a REASON rather than an empty graph when
 * a channel cannot be resolved — "I could not check" must never render as "nothing is
 * missing", which is the reading that would let the move proceed onto a channel that
 * cannot reserve inventory.
 */
async function readStockLocations(
  query: { graph: (args: any) => Promise<any> },
  marketplace: MedusaIdResolution,
  operating: MedusaIdResolution,
): Promise<StockLocationReport> {
  if (marketplace.status !== 'resolved') {
    return {
      available: false,
      reason: `Marketplace channel unavailable — cannot determine which stock locations the operating channel must carry: ${marketplace.reason}`,
      marketplace_location_ids: [], operating_location_ids: [], missing_on_operating: [],
    }
  }
  if (operating.status !== 'resolved') {
    return {
      available: false,
      reason: `Operating channel unavailable: ${operating.reason}`,
      marketplace_location_ids: [], operating_location_ids: [], missing_on_operating: [],
    }
  }
  const marketplaceIds = await locationIdsForChannel(query as any, marketplace.id)
  const operatingIds = await locationIdsForChannel(query as any, operating.id)
  const plan = planStockLocationLinks(marketplaceIds, operatingIds)
  return {
    available: true,
    reason: null,
    marketplace_location_ids: plan.marketplace_location_ids,
    operating_location_ids: plan.operating_location_ids,
    missing_on_operating: plan.missing_on_operating,
  }
}

interface Survey {
  readonly market: MarketCode
  readonly desired: DesiredChannel
  readonly marketplace: MedusaIdResolution
  readonly operating: MedusaIdResolution
  readonly targetChannelId: string | null
  readonly channelExistsInDatabase: boolean
  readonly plan: KeyChannelMovePlan | null
  readonly keyQueryError: string | null
  readonly stockLocations: StockLocationReport
}

/** Read everything both halves need. READ-ONLY, so the GET is honestly side-effect free. */
async function survey(req: MedusaRequest, market: MarketCode, desired: DesiredChannel): Promise<Survey> {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const marketplace = resolveMarketplaceChannelForMarket(market, process.env)
  const operating = resolveOperatingChannelForMarket(market, process.env)
  const target = desired === 'operating' ? operating : marketplace
  const targetChannelId = target.status === 'resolved' ? target.id : null

  // A configured id with no row is a GHOST — indistinguishable from a healthy one
  // until the link workflow half-fails. `validateSalesChannelsExistStep` inside the
  // workflow would also catch it, but only AFTER the dry run promised a move.
  let channelExists = false
  if (targetChannelId) {
    const { data } = await query.graph({
      entity: 'sales_channel',
      fields: ['id', 'name'],
      filters: { id: targetChannelId } as any,
    })
    channelExists = ((data ?? []).length > 0)
  }

  // `sales_channels.*` (the wildcard, not named subfields) — the named-field form is
  // what crashed this exact query in production 2026-07-27. `token` is selected so
  // the plan can positively identify the storefront's own credential.
  let plan: KeyChannelMovePlan | null = null
  let keyQueryError: string | null = null
  try {
    const { data } = await query.graph({
      entity: 'api_key',
      fields: ['id', 'type', 'title', 'token', 'sales_channels.*'],
      filters: { type: 'publishable' } as any,
    })
    plan = planPublishableKeyChannelMove(data, {
      desiredChannelIds: targetChannelId ? [targetChannelId] : [],
      storefrontToken: process.env.MEDUSA_PUBLISHABLE_KEY ?? null,
    })
  } catch (e: any) {
    // A route that exits green having read nothing reads as a passing gate. This one
    // repoints a live credential — fail loudly.
    keyQueryError = e?.message ?? 'api_key query failed'
  }

  return {
    market, desired, marketplace, operating, targetChannelId,
    channelExistsInDatabase: channelExists,
    plan, keyQueryError,
    stockLocations: await readStockLocations(query, marketplace, operating),
  }
}

/**
 * Every precondition, evaluated BEFORE any write and pure with respect to the survey,
 * so the GET renders exactly the verdict the POST will enforce.
 */
function blockingReasons(s: Survey): string[] {
  const blocked: string[] = []

  if (s.keyQueryError) {
    blocked.push(`api_key query failed: ${s.keyQueryError}`)
  }
  const target = s.desired === 'operating' ? s.operating : s.marketplace
  if (target.status !== 'resolved') {
    blocked.push(`Target (${s.desired}) channel unavailable for market "${s.market}": ${target.reason}`)
  } else if (!s.channelExistsInDatabase) {
    blocked.push(
      `Channel "${target.id}" is configured for the ${s.desired} channel but no such Sales Channel exists in this database. ` +
      'Refusing to point the storefront key at a ghost — fix or unset the env var first.',
    )
  }

  // ── D5 ─────────────────────────────────────────────────────────────────────
  // Only load-bearing for the FORWARD move: pointing the key back at the
  // marketplace channel (D9's rollback) restores today's graph, which is known
  // good, and must not be blockable by the very condition it is undoing.
  if (s.desired === 'operating') {
    if (!s.stockLocations.available) {
      blocked.push(
        `Stock-location graph unavailable, so D5 cannot be proven: ${s.stockLocations.reason}. ` +
        'Refusing — a cart on a channel with no stock location fails reservation AFTER payment.',
      )
    } else if (s.stockLocations.missing_on_operating.length > 0) {
      blocked.push(
        `D5 unmet: the operating channel is missing ${s.stockLocations.missing_on_operating.length} stock-location link(s) ` +
        `the marketplace channel has [${s.stockLocations.missing_on_operating.join(', ')}]. ` +
        'Run POST /internal/operating-channel-provision (or the operating-channel-backfill apply) first — ' +
        'moving the cart onto a channel that cannot reserve inventory breaks completion, not checkout, so it fails after payment.',
      )
    }
  }

  if (s.plan?.refuse) blocked.push(s.plan.refuse)
  if (!s.plan) blocked.push('No publishable-key plan could be produced.')

  return blocked
}

function reportBody(s: Survey, blocked: string[]) {
  return {
    market_code: s.market,
    desired_channel: s.desired,
    target_channel_id: s.targetChannelId,
    target_channel_exists: s.channelExistsInDatabase,
    channels: {
      marketplace: s.marketplace.status === 'resolved' ? s.marketplace.id : null,
      operating: s.operating.status === 'resolved' ? s.operating.id : null,
    },
    apply_allowed: blocked.length === 0,
    blocked_by: blocked,
    key: s.plan
      ? {
          storefront_token_check: s.plan.storefront_token_check,
          target: s.plan.target,
          all_keys: s.plan.all_keys,
          links_before: s.plan.links_before,
          links_after_predicted: s.plan.links_after_predicted,
          add: s.plan.add,
          remove: s.plan.remove,
          already_satisfied: s.plan.already_satisfied,
          refuse: s.plan.refuse,
        }
      : null,
    key_query_error: s.keyQueryError,
    stock_locations: s.stockLocations,
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!authed(req)) return res.status(401).json({ message: 'Unauthorized' })

  let market: MarketCode
  try {
    market = requireMarket((req.query as Record<string, string>)?.market ?? DEFAULT_MARKET).code
  } catch (e) {
    return res.status(400).json({ message: (e as Error).message })
  }
  const desired = readDesiredChannel((req.query as Record<string, unknown>)?.desired_channel)
  if (!desired) {
    return res.status(400).json({ message: 'desired_channel must be "operating" or "marketplace".' })
  }

  const s = await survey(req, market, desired)
  return res.json({ dry_run: true, applied: false, ...reportBody(s, blockingReasons(s)) })
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!authed(req)) return res.status(401).json({ message: 'Unauthorized' })

  const body = (req.body ?? {}) as { dry_run?: boolean; market?: unknown; desired_channel?: unknown }
  const dryRun = body.dry_run !== false // default true — safe by default

  let market: MarketCode
  try {
    market = requireMarket(body.market ?? DEFAULT_MARKET).code
  } catch (e) {
    return res.status(400).json({ message: (e as Error).message })
  }
  const desired = readDesiredChannel(body.desired_channel)
  if (!desired) {
    return res.status(400).json({ message: 'desired_channel must be "operating" or "marketplace".' })
  }

  // ── VALIDATE (BEFORE any write, and identically to what the GET showed) ─────
  const s = await survey(req, market, desired)
  const blocked = blockingReasons(s)
  if (blocked.length > 0 || !s.plan || !s.plan.target || !s.targetChannelId) {
    return res.status(422).json({
      dry_run: dryRun,
      applied: false,
      ...reportBody(s, blocked.length > 0 ? blocked : ['No applicable plan.']),
    })
  }
  if (dryRun) {
    return res.json({ dry_run: true, applied: false, ...reportBody(s, blocked) })
  }
  if (s.plan.already_satisfied) {
    return res.json({
      dry_run: false, applied: false, message: 'nothing to move — the key already holds exactly the desired channel',
      ...reportBody(s, blocked),
    })
  }

  // ── APPLY ──────────────────────────────────────────────────────────────────
  // ONE workflow call carrying both halves. `linkSalesChannelsToApiKeyStep` issues
  // the `remoteLink.create` and `remoteLink.dismiss` through a single `promiseAll`
  // (verified in the installed core-flows source), and it has a compensation handler
  // that restores both sides — which is why this is one call and not an unlink
  // followed by a link. Two sequential calls would have a window in which the key
  // holds zero channels, and a key with no channel scope serves an EMPTY catalog.
  await linkSalesChannelsToApiKeyWorkflow(req.scope).run({
    input: {
      id: s.plan.target.key_id,
      add: [...s.plan.add],
      remove: [...s.plan.remove],
    },
  })

  // Re-read rather than reporting what we intended — a link that matched nothing must
  // not come back looking like a success (AGENTS → a read is not a claim).
  const after = await survey(req, market, desired)
  const verifiedTarget = after.plan?.target ?? null
  const linksAfter = verifiedTarget ? verifiedTarget.channel_ids.length : null

  return res.json({
    dry_run: false,
    // The one number the epic's Definition of Done is written in terms of.
    applied: true,
    links_before: s.plan.links_before,
    links_after: linksAfter,
    // A verified 1 → 1 landing on the requested channel. Anything else is a defect,
    // and it is stated here rather than left for a reviewer to work out.
    verified: linksAfter === 1 && verifiedTarget?.channel_ids[0] === s.targetChannelId,
    added: s.plan.add,
    removed: s.plan.remove,
    ...reportBody(after, blockingReasons(after)),
  })
}
