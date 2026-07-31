/**
 * sales-channel-writers.ts — the MECHANICALLY DERIVED population of every place in
 * this repo that can change the Sales Channel graph, and its classification.
 *
 * ── Why this exists ────────────────────────────────────────────────────────────
 * The owned-shop-operating-channel epic makes channel membership the thing that
 * decides whether a product can be BOUGHT (D2/D3). Before it, membership only
 * decided marketplace visibility, so a write path that forgot to attach a channel
 * produced an invisible listing — annoying, findable. After it, the same omission
 * produces a listing that renders perfectly and 404s at checkout.
 *
 * `LEARNINGS.md`: **guard the population, not the door you found.** Sprint 2's story
 * asked for "every create/update writer", and the writer everyone remembers is
 * `seller-product-create.ts`. There is a second one
 * (`internal/print/placement-product`), a seeding one, two backfills, and — new in
 * this sprint — the publishable-key move. A registry maintained by memory would have
 * held one of six.
 *
 * ── How the guard actually guards ──────────────────────────────────────────────
 * The companion spec walks the **whole of `src/`** with the TypeScript AST (never a
 * hand-picked list of directories — a scan that chooses its own roots covers less
 * every month while still passing) and derives, per file:
 *
 *   · every `sales_channels:` PROPERTY ASSIGNMENT, and
 *   · every call to one of `SALES_CHANNEL_WORKFLOW_PRIMITIVES`.
 *
 * It then compares that derivation to `SALES_CHANNEL_WRITER_REGISTRY` below. A new
 * occurrence anywhere in `src/` lands in no bucket and REDDENS. A registry row whose
 * code was deleted also reddens, so this cannot rot into plausible-looking fiction.
 *
 * ── Why response-shaping sites are registered too ──────────────────────────────
 * `sales_channels:` also appears where a diagnostic BUILDS ITS RESPONSE. Those are
 * not writes. They are registered anyway, classified `response_shape`, because the
 * alternative is a detector clever enough to tell a response from an input — and a
 * guard that rejects correct output is worse than one that misses a rare fault
 * (`LEARNINGS.md`, shipped twice). Classifying is honest; guessing is not.
 */

/**
 * The Medusa core-flow workflows that mutate the Sales Channel graph.
 *
 * Deliberately includes the channel LIFECYCLE (create/delete) and the STOCK-LOCATION
 * link, not just product membership: D5 proved that a channel with no stock location
 * cannot reserve inventory, so "which locations is this channel linked to" is part of
 * the same graph and the same blast radius as "which products are in it".
 */
export const SALES_CHANNEL_WORKFLOW_PRIMITIVES = [
  'createSalesChannelsWorkflow',
  'deleteSalesChannelsWorkflow',
  'linkProductsToSalesChannelWorkflow',
  'linkSalesChannelsToApiKeyWorkflow',
  'linkSalesChannelsToStockLocationWorkflow',
] as const

export type SalesChannelWorkflowPrimitive = typeof SALES_CHANNEL_WORKFLOW_PRIMITIVES[number]

/** The literal property name the AST scan looks for on an object literal. */
export const SALES_CHANNEL_PROPERTY = 'sales_channels'

export type SalesChannelWriterPrimitive = SalesChannelWorkflowPrimitive | typeof SALES_CHANNEL_PROPERTY

/**
 * What a site does. Three of these are real writes; `response_shape` is a read that
 * merely spells the same word, and is registered so the detector can stay dumb.
 */
export type SalesChannelWriterKind =
  | 'product_create'
  | 'product_membership'
  | 'publishable_key_membership'
  | 'stock_location_membership'
  | 'channel_lifecycle'
  | 'seed'
  | 'response_shape'

export interface SalesChannelWriter {
  /** Repo-relative, forward-slashed. */
  readonly file: string
  readonly primitive: SalesChannelWriterPrimitive
  readonly kind: SalesChannelWriterKind
  /** Why this site is allowed to exist, in one line. */
  readonly note: string
}

/**
 * THE POPULATION. Sorted by `file` then `primitive` so a diff on this file reads as a
 * diff of the graph itself.
 *
 * Adding a row here is a deliberate act: it means a new thing can change what is
 * buyable. Every `product_create` row must attach the OPERATING channel (D2) — the
 * spec asserts the two that exist do.
 */
export const SALES_CHANNEL_WRITER_REGISTRY: readonly SalesChannelWriter[] = [
  {
    file: 'src/api/internal/_utils/operating-channel-provision.ts',
    primitive: 'createSalesChannelsWorkflow',
    kind: 'channel_lifecycle',
    note: 'Creates the market operating channel (S1.3). Refuses when the env var already names a ghost.',
  },
  {
    file: 'src/api/internal/backfill-sales-channel/route.ts',
    primitive: SALES_CHANNEL_PROPERTY,
    kind: 'response_shape',
    note: 'Diagnostic response body only — its POST is retired (410). No write.',
  },
  {
    file: 'src/api/internal/market-backfill/route.ts',
    primitive: 'linkProductsToSalesChannelWorkflow',
    kind: 'product_membership',
    note: 'Marketplace-channel backfill, scoped to each product\'s owning seller market.',
  },
  {
    file: 'src/api/internal/operating-channel-backfill/route.ts',
    primitive: 'linkProductsToSalesChannelWorkflow',
    kind: 'product_membership',
    note: 'Operating-channel backfill (S1.4, D6 — every status, not only published).',
  },
  {
    file: 'src/api/internal/print/placement-product/route.ts',
    primitive: SALES_CHANNEL_PROPERTY,
    kind: 'product_create',
    note: 'Print placement product for the platform seller. Attaches planProductPublication\'s full channel set.',
  },
  {
    file: 'src/api/internal/prune-sales-channels/route.ts',
    primitive: 'deleteSalesChannelsWorkflow',
    kind: 'channel_lifecycle',
    note: 'Destructive prune, guarded by the registry-derived protectedSalesChannelIds allow-list.',
  },
  {
    file: 'src/api/internal/publishable-key-channel-move/route.ts',
    primitive: 'linkSalesChannelsToApiKeyWorkflow',
    kind: 'publishable_key_membership',
    note: 'S2.1 — the ONLY site that changes which channel the storefront key resolves to (D3).',
  },
  {
    file: 'src/api/store/_utils/inventory.ts',
    primitive: 'linkSalesChannelsToStockLocationWorkflow',
    kind: 'stock_location_membership',
    note: 'ensureSalesChannelLocationLink — D5\'s single implementation, reused by provisioning and both backfills.',
  },
  {
    file: 'src/api/store/_utils/seller-product-create.ts',
    primitive: SALES_CHANNEL_PROPERTY,
    kind: 'product_create',
    note: 'The seller-product create path. Attaches planProductPublication\'s full channel set (operating + marketplace).',
  },
  // ── The seed's four rows. ────────────────────────────────────────────────────
  // Registered because the AST scan found them, NOT because anyone remembered them:
  // the first draft of this registry held only the two product-create paths and the
  // two backfills, and the derivation immediately reddened on all four of these. That
  // is the whole argument for deriving the population instead of listing it. The seed
  // is also the source of the 72-publishable-key / 15-dangling-link residue this repo
  // spent two epics cleaning up (see `_utils/api-key-cleanup.ts`), so it is precisely
  // the file that must not quietly grow a fifth channel write.
  {
    file: 'src/migration-scripts/initial-data-seed.ts',
    primitive: SALES_CHANNEL_PROPERTY,
    kind: 'seed',
    note: 'First-boot demo seed, guarded by a store-exists check. Never runs against a populated database.',
  },
  {
    file: 'src/migration-scripts/initial-data-seed.ts',
    primitive: 'createSalesChannelsWorkflow',
    kind: 'seed',
    note: 'Creates the first-boot default channel. Same store-exists guard.',
  },
  {
    file: 'src/migration-scripts/initial-data-seed.ts',
    primitive: 'linkSalesChannelsToApiKeyWorkflow',
    kind: 'seed',
    note: 'Links the seeded publishable key to the seeded channel — the ONE other site that touches key↔channel links.',
  },
  {
    file: 'src/migration-scripts/initial-data-seed.ts',
    primitive: 'linkSalesChannelsToStockLocationWorkflow',
    kind: 'seed',
    note: 'Links the seeded stock location to the seeded channel (the D5 graph\'s origin).',
  },
]

/**
 * The subset that CREATES products. Every one of these must attach the operating
 * channel, which in practice means routing through `planProductPublication` — the
 * one seam that knows the D2 rule.
 */
export const PRODUCT_CREATE_WRITERS: readonly SalesChannelWriter[] =
  SALES_CHANNEL_WRITER_REGISTRY.filter((entry) => entry.kind === 'product_create')

export interface SalesChannelWriterSite {
  readonly file: string
  readonly primitive: string
}

export type SalesChannelWriterValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] }

/**
 * Compare an independently derived site inventory against the registry.
 *
 * Unregistered, missing and duplicate rows all fail TOGETHER rather than one at a
 * time — a partial answer here reads like a complete one, and the whole reason this
 * file exists is that a partial population passed for a complete one before.
 */
export function validateSalesChannelWriterInventory(
  sites: readonly SalesChannelWriterSite[],
): SalesChannelWriterValidation {
  const errors: string[] = []
  const seen = new Set<string>()
  const expected = new Set(
    // `\u0000` is the ESCAPE SEQUENCE, deliberately — six printable characters that
    // produce one NUL at runtime. A NUL cannot occur in a file path or an identifier,
    // so it is the one delimiter that can never collide. Do NOT "fix" this into a
    // literal NUL byte: that makes the file binary to git and CRASHES the
    // cross-agent review layer (see `no-literal-nul-bytes.unit.spec.ts`, which exists
    // because exactly that happened on PR 130).
    SALES_CHANNEL_WRITER_REGISTRY.map((entry) => `${entry.file}\u0000${entry.primitive}`),
  )

  for (const site of sites) {
    const identity = `${site.file}\u0000${site.primitive}`
    if (seen.has(identity)) {
      errors.push(`duplicate site: ${site.primitive} @ ${site.file}`)
      continue
    }
    seen.add(identity)
    if (!expected.has(identity)) {
      errors.push(
        `UNREGISTERED sales-channel writer: ${site.primitive} @ ${site.file} — ` +
        'classify it in SALES_CHANNEL_WRITER_REGISTRY. If it creates products it MUST attach the operating channel (D2).',
      )
    }
  }

  for (const identity of expected) {
    if (!seen.has(identity)) {
      const [file, primitive] = identity.split('\u0000')
      errors.push(`stale registry row: ${primitive} @ ${file} no longer exists in src/`)
    }
  }

  return errors.length === 0
    ? { ok: true }
    : { ok: false, errors: errors.sort((left, right) => left.localeCompare(right)) }
}
