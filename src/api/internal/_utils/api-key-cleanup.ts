/**
 * Publishable-API-key cleanup planner — the pure half of
 * `POST /internal/prune-api-keys`.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Production accumulated 72 publishable keys for a marketplace with ONE
 * storefront. They are not a live duplication bug: `initial-data-seed.ts` used
 * to run repeatedly against a populated DB, and each run created a store + a
 * sales channel + a publishable key + the link between them. Commit e951b5f
 * added a store-exists guard, so the source is closed — this planner cleans up
 * what it already produced.
 *
 * 70 of the 72 link rows dangle: they point at sales channels that were deleted
 * (55 by earlier cleanups, 15 by `/internal/prune-sales-channels` on 2026-07-27,
 * which called the module service directly and therefore skipped
 * `removeRemoteLinkStep`). `query.graph` expands a dangling link into a
 * null-ish entry with no `id` — which is what was crashing the diagnostic
 * before PR #116.
 *
 * ── Why deleting the keys is enough ────────────────────────────────────────
 * `deleteApiKeysWorkflow` runs `removeRemoteLinkStep({ [Modules.API_KEY]:
 * { publishable_key_id: ids } })`, which deletes link rows BY KEY ID — it does
 * not join to `sales_channel`, so a dangling row goes with its key. Verified in
 * the installed core-flows source, not assumed.
 *
 * ── The safety contract ────────────────────────────────────────────────────
 * This deletes production commerce credentials, so the planner REFUSES rather
 * than guessing. Deleting the one key the storefront authenticates with would
 * take the catalog down. Every refusal below is a case where the plan cannot be
 * shown to be safe — and "I could not check" is kept distinct from "there is
 * none" (AGENTS → three states, never two).
 */

/** One `api_key` row as `query.graph` returns it — every field defensively optional. */
export type PublishableKeyRow = {
  id?: string | null
  title?: string | null
  token?: string | null
  revoked_at?: string | Date | null
  sales_channels?: Array<{ id?: string | null; name?: string | null } | null | undefined> | null
}

/**
 * Mirror of the delete precondition in the api-key module service — NOT a
 * paraphrase of it. Source:
 * `@medusajs/api-key/dist/services/api-key-module-service.js` `deleteApiKeys_`,
 * which refuses any key matching `revoked_at IS NULL OR revoked_at > now()`:
 *
 *     Cannot delete api keys that are not revoked - apk_…
 *
 * Measured in production 2026-07-27: the first apply attempt 400'd on all 71
 * keys for exactly this reason. A future-dated `revoked_at` counts as NOT
 * revoked, which is why this is a comparison and not a null check — restating
 * the rule as "has a revoked_at" would fork it permissively.
 */
export function isRevoked(revokedAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (revokedAt === null || revokedAt === undefined) return false
  const t = revokedAt instanceof Date ? revokedAt : new Date(revokedAt)
  if (Number.isNaN(t.getTime())) return false // unparseable ⇒ cannot claim revoked
  return t.getTime() <= now.getTime()
}

export type KeyPlanEntry = {
  id: string
  title: string | null
  /** Publishable tokens are public by design (they ship in the browser bundle), but there is no reason to echo them whole. */
  token_prefix: string | null
  live_links: number
  dangling_links: number
  keep_reason: 'live_sales_channel_link' | 'configured_storefront_token' | null
  /** Per the module's own delete precondition — see `isRevoked`. A key that is not revoked CANNOT be deleted. */
  revoked: boolean
}

/**
 * Three states, not two. `matched`/`not_found` are findings; `unavailable` means
 * the check could not run (no configured token, or the `token` field came back
 * empty on every row) and must NOT be read as "the storefront key is missing".
 */
export type StorefrontTokenCheck = 'matched' | 'not_found' | 'unavailable'

export type ApiKeyCleanupPlan = {
  total_keys: number
  total_live_links: number
  total_dangling_links: number
  keep: KeyPlanEntry[]
  delete: KeyPlanEntry[]
  storefront_token_check: StorefrontTokenCheck
  /** Rows with no usable `id` — we cannot reason about them, so their presence is fatal. */
  unusable_rows: number
  /**
   * How many of `delete` must be REVOKED before they can be deleted. The apply
   * path revokes these first; a dry run that omitted this predicted an outcome
   * the apply could not deliver, which is how the first production attempt 400'd.
   */
  requires_revoke: number
  /** Non-null ⇒ do not apply. The string is the reason, meant to be returned verbatim. */
  refuse: string | null
}

const trimmed = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}

/**
 * Decide which publishable keys to keep and which to delete.
 *
 * Keep rule — a key is kept if EITHER holds:
 *   1. it has at least one link that resolves to a live sales channel, or
 *   2. its token equals the configured storefront publishable key.
 *
 * (2) is belt-and-braces: it is the storefront's own credential, so it is kept
 * even if its channel link were somehow broken. (1) is what actually identifies
 * the survivor today.
 */
export function planApiKeyCleanup(
  rows: unknown,
  opts: { storefrontToken?: string | null; protectedTokens?: readonly string[]; now?: Date } = {},
): ApiKeyCleanupPlan {
  const list: PublishableKeyRow[] = Array.isArray(rows) ? (rows as PublishableKeyRow[]) : []
  const configuredTokens = new Set(
    [opts.storefrontToken, ...(opts.protectedTokens ?? [])]
      .map(trimmed)
      .filter((token): token is string => !!token),
  )
  const now = opts.now ?? new Date()

  const keep: KeyPlanEntry[] = []
  const toDelete: KeyPlanEntry[] = []
  let totalLive = 0
  let totalDangling = 0
  let unusableRows = 0
  let sawAnyToken = false
  const matchedTokens = new Set<string>()

  for (const row of list) {
    const id = trimmed(row?.id)
    if (!id) {
      // A key row with no id is the one thing we cannot act on: we can neither
      // keep it nor name it in a delete list. Count it and let the refusal fire.
      unusableRows += 1
      continue
    }

    const token = trimmed(row?.token)
    if (token) sawAnyToken = true

    const links = Array.isArray(row?.sales_channels) ? row.sales_channels : []
    let live = 0
    let dangling = 0
    for (const link of links) {
      if (link && trimmed(link.id)) live += 1
      else dangling += 1
    }
    totalLive += live
    totalDangling += dangling

    const isStorefrontKey = !!token && configuredTokens.has(token)
    if (isStorefrontKey && token) matchedTokens.add(token)

    // A live link is the stronger signal, so it wins the reason label when both hold.
    const keepReason: KeyPlanEntry['keep_reason'] =
      live > 0 ? 'live_sales_channel_link' : isStorefrontKey ? 'configured_storefront_token' : null

    const entry: KeyPlanEntry = {
      id,
      title: trimmed(row?.title),
      token_prefix: token ? token.slice(0, 12) : null,
      live_links: live,
      dangling_links: dangling,
      keep_reason: keepReason,
      revoked: isRevoked(row?.revoked_at, now),
    }

    if (keepReason) keep.push(entry)
    else toDelete.push(entry)
  }

  const requiresRevoke = toDelete.filter(k => !k.revoked).length

  // `unavailable` when we had nothing to compare against — either no configured
  // token, or the token field came back empty on every row (a field-selection
  // change would look exactly like that, and must not read as "not found").
  const storefrontCheck: StorefrontTokenCheck = configuredTokens.size === 0 || !sawAnyToken
    ? 'unavailable'
    : matchedTokens.size === configuredTokens.size
      ? 'matched'
      : 'not_found'

  return {
    total_keys: list.length,
    total_live_links: totalLive,
    total_dangling_links: totalDangling,
    keep,
    delete: toDelete,
    storefront_token_check: storefrontCheck,
    unusable_rows: unusableRows,
    requires_revoke: requiresRevoke,
    refuse: refusalFor({ list, keep, storefrontCheck, unusableRows }),
  }
}

function refusalFor(args: {
  list: PublishableKeyRow[]
  keep: KeyPlanEntry[]
  storefrontCheck: StorefrontTokenCheck
  unusableRows: number
}): string | null {
  const { list, keep, storefrontCheck, unusableRows } = args

  // An empty read is the classic false-green: "no keys" and "the query failed"
  // look identical downstream. Never treat it as a completed no-op.
  if (list.length === 0) {
    return 'no publishable keys were returned — refusing to act on an empty read'
  }
  if (unusableRows > 0) {
    return `${unusableRows} key row(s) came back with no id — refusing while part of the population is unreadable`
  }
  if (keep.length === 0) {
    return 'no key qualifies to be kept — refusing to delete every publishable key'
  }
  // Only fires when the check actually RAN and failed. `unavailable` is not a
  // failure: it means we fell back to the live-link rule, which is sound.
  if (storefrontCheck === 'not_found') {
    return 'a storefront publishable key is configured but matches none of these keys — refusing while the live credential is unaccounted for'
  }
  return null
}
