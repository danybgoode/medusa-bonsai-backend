/**
 * src/lib/seller-channel-ledger.ts
 *
 * The pause/unpause channel-link ledger (tenant-lifecycle-admin · D4).
 *
 * ── WHY A LEDGER AND NOT "RELINK EVERYTHING" ──────────────────────────────────
 * Pausing a shop makes its products invisible by unlinking them from the market
 * sales channels — Medusa's own publication truth (`/store/listings` says so
 * outright: "Sales Channel membership IS marketplace-publication truth"), which is
 * why no read path needs a new filter to obey a pause.
 *
 * Unpausing is NOT "link every product this seller owns to every market channel".
 * A seller can legitimately own products that were unlinked for entirely different
 * reasons, and relinking them would publish things nobody asked to publish:
 *
 *   · an owned-shop-only product is deliberately ABSENT from the marketplace channel
 *     (`catalog.owned_shop_only_enabled`) and present only in the operating channel;
 *   · a DRAFT is linked to the operating channel but not the marketplace one
 *     (owned-shop epic D6 links drafts deliberately, so publishing later is instant);
 *   · a product pulled from one market during a market migration.
 *
 * So pause RECORDS the exact `(product_id, sales_channel_id)` pairs it removed, and
 * unpause replays that set and clears it. Without this, unpausing an owned-shop
 * merchant would silently expose its private catalog to the marketplace — a privacy
 * regression caused by a feature that is supposed to be reversible.
 *
 * Pure: pair maths only. The route is the I/O shell.
 */

/** Where the ledger lives on the seller row. */
export const PAUSED_LINKS_KEY = 'paused_channel_links'

export type ChannelLink = { product_id: string; sales_channel_id: string }

/**
 * Stable key for set operations — the pair IS the identity.
 *
 * `|` rather than a NUL byte: NUL is the tempting separator because it cannot occur
 * in an id, but a literal NUL in source crashes cross-review, and there is a spec
 * (`no-literal-nul-bytes`) that fails the build over exactly this. Medusa ids are
 * `prefix_ULID` — lowercase prefix, underscore, Crockford base32 — so a pipe cannot
 * appear in one either, and it survives being read by a human.
 */
function pairKey(link: ChannelLink): string {
  return `${link.product_id}|${link.sales_channel_id}`
}

export type ParsedLedger = {
  links: ChannelLink[]
  /**
   * Entries that could not be parsed into a replayable pair.
   *
   * COUNTED, not silently dropped. A malformed entry means the shop is owed a link
   * we can no longer name — so a restore that meets one is INCOMPLETE, and reporting
   * it complete would clear the only evidence that anything was lost. Duplicates do
   * not count here: dropping a repeat loses nothing.
   */
  dropped: number
}

/**
 * Parse a ledger off `seller.metadata`, defensively, and say what it could not read.
 *
 * A malformed entry cannot be replayed — a pair with a missing or non-string id would
 * either throw mid-restore or link something arbitrary — so it is dropped from the
 * replay set and counted in `dropped`. Returns empty for an absent ledger, which is a
 * legitimate state (a shop paused while it owned nothing).
 */
export function parsePausedLinks(metadata: unknown): ParsedLedger {
  if (!metadata || typeof metadata !== 'object') return { links: [], dropped: 0 }
  const raw = (metadata as Record<string, unknown>)[PAUSED_LINKS_KEY]
  if (raw === undefined || raw === null) return { links: [], dropped: 0 }
  // A ledger that is not even an array is one unreadable thing, not nothing.
  if (!Array.isArray(raw)) return { links: [], dropped: 1 }
  const links: ChannelLink[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') { dropped += 1; continue }
    const { product_id, sales_channel_id } = entry as Record<string, unknown>
    if (typeof product_id !== 'string' || product_id === '') { dropped += 1; continue }
    if (typeof sales_channel_id !== 'string' || sales_channel_id === '') { dropped += 1; continue }
    const link = { product_id, sales_channel_id }
    const key = pairKey(link)
    if (seen.has(key)) continue
    seen.add(key)
    links.push(link)
  }
  return { links, dropped }
}

/** The replayable pairs only. Callers that must notice corruption use `parsePausedLinks`. */
export function readPausedLinks(metadata: unknown): ChannelLink[] {
  return parsePausedLinks(metadata).links
}

/** Union two ledgers, deduplicated — used to make a re-run of pause additive. */
export function mergeLedgers(a: readonly ChannelLink[], b: readonly ChannelLink[]): ChannelLink[] {
  return buildPausedLinks([...a, ...b])
}

/**
 * The ledger to record when pausing: exactly the links being removed, deduplicated
 * and in a stable order so two pauses of the same shop produce identical records.
 */
export function buildPausedLinks(current: readonly ChannelLink[]): ChannelLink[] {
  const seen = new Set<string>()
  const links: ChannelLink[] = []
  for (const link of current) {
    if (typeof link?.product_id !== 'string' || typeof link?.sales_channel_id !== 'string') continue
    if (link.product_id === '' || link.sales_channel_id === '') continue
    const key = pairKey(link)
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ product_id: link.product_id, sales_channel_id: link.sales_channel_id })
  }
  return links.sort((a, b) => pairKey(a).localeCompare(pairKey(b)))
}

export type RestorePlan = {
  /** Pairs to link back. */
  restore: ChannelLink[]
  /**
   * Pairs the ledger holds that are ALREADY linked — someone relinked them while the
   * shop was paused. Reported, not re-linked: a duplicate link row is the exact
   * corruption the owned-shop epic spent a sprint cleaning up.
   */
  alreadyLinked: ChannelLink[]
  /**
   * Pairs whose product no longer exists. Reported so a restore that could not be
   * complete says so, rather than quietly restoring fewer links than it recorded.
   */
  missingProducts: ChannelLink[]
}

/**
 * Plan an unpause against what is true NOW, not against what was true at pause time.
 *
 * The ledger is a record of intent; the world moved underneath it. Every pair falls
 * into exactly one bucket, and the sum of the three always equals the ledger size —
 * so a caller can assert completeness rather than trust it.
 */
export function planRestore(
  ledger: readonly ChannelLink[],
  currentLinks: readonly ChannelLink[],
  existingProductIds: ReadonlySet<string>,
): RestorePlan {
  const linked = new Set(currentLinks.map(pairKey))
  const plan: RestorePlan = { restore: [], alreadyLinked: [], missingProducts: [] }
  for (const link of ledger) {
    if (!existingProductIds.has(link.product_id)) {
      plan.missingProducts.push(link)
      continue
    }
    if (linked.has(pairKey(link))) {
      plan.alreadyLinked.push(link)
      continue
    }
    plan.restore.push(link)
  }
  return plan
}

/**
 * Is this restore complete — did every recorded pair end up linked?
 *
 * `alreadyLinked` counts as complete (the pair IS linked, we simply did not do it).
 * `missingProducts` does NOT: the shop came back with less than it had, and that is a
 * fact the operator must see rather than infer from a row count.
 */
export function restoreIsComplete(plan: RestorePlan): boolean {
  return plan.missingProducts.length === 0
}
