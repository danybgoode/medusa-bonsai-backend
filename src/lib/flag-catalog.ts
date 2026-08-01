/**
 * The complete Medusa-owned portion of Miyagi's flag inventory.
 *
 * Every owner is a source file which calls the public `isEnabled()` seam. A
 * source-derived unit spec compares this registry to the TypeScript AST, so a
 * new call site cannot silently bypass classification and a deleted call site
 * cannot leave plausible-looking stale ownership documentation behind.
 */
export type FlagPolarity = 'enablement' | 'killswitch'
export type FlagCriticality = 'low' | 'medium' | 'high'

type FlagCatalogMetadata = {
  compileDefault: boolean
  polarity: FlagPolarity
  criticality: FlagCriticality
  description: string
  owners: readonly string[]
}

const FLAG_CATALOG_DEFINITIONS = {
  'checkout.stripe_enabled': {
    compileDefault: true,
    polarity: 'killswitch',
    criticality: 'high',
    description: 'Stripe card payments; OFF removes the Stripe rail from checkout.',
    owners: [
      'src/api/store/carts/[id]/start-checkout/route.ts',
      'src/api/store/sellers/[slug]/checkout-options/route.ts',
    ],
  },
  'checkout.rental_pricing_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'high',
    description: 'Server-priced rental checkout; OFF preserves seller coordination.',
    owners: ['src/api/store/carts/[id]/start-checkout/route.ts'],
  },
  'shipping.envia_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'high',
    description: 'Envía carrier quotes and fulfillment; OFF preserves arranged/manual delivery.',
    owners: [
      'src/api/store/envia/rates/route.ts',
      'src/api/store/sellers/me/orders/[id]/ship/route.ts',
    ],
  },
  'shipping.correos_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'high',
    description: 'Correos de México economy rate; OFF keeps the rate out of checkout.',
    owners: [
      'src/api/store/envia/rates/route.ts',
      'src/api/store/sellers/[slug]/checkout-options/route.ts',
    ],
  },
  'shipping.arranged_only_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'high',
    description: 'Per-listing arranged-only delivery; OFF preserves carrier-required behavior.',
    owners: [
      'src/api/store/carts/[id]/start-checkout/route.ts',
      'src/api/store/sellers/[slug]/checkout-options/route.ts',
    ],
  },
  'ml.sync_enabled': {
    compileDefault: false,
    polarity: 'killswitch',
    criticality: 'high',
    description: 'Two-way Mercado Libre stock sync; it deliberately fails closed to OFF.',
    owners: [
      'src/api/store/_utils/seller-product-update.ts',
      'src/api/webhooks/mercadolibre/route.ts',
      'src/jobs/reconcile-ml-inventory.ts',
      'src/jobs/reconcile-ml-order-status.ts',
      'src/subscribers/ml-inventory-sync.ts',
    ],
  },
  'ml.orders_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'high',
    description: 'Materializes paid Mercado Libre sales as Medusa orders.',
    owners: [
      'src/api/webhooks/mercadolibre/route.ts',
      'src/jobs/reconcile-ml-inventory.ts',
      'src/jobs/reconcile-ml-order-status.ts',
    ],
  },
  'ml.sync_paywall_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'low',
    description: 'Requires the paid entitlement before Mercado Libre sync/orders can run.',
    owners: ['src/lib/ml-orders-entitlement.ts'],
  },
  'ops.profit_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'medium',
    description: 'Profit ledger writes and seller profit reads; OFF preserves an inert ledger.',
    owners: [
      'src/api/internal/profit/apply-price/route.ts',
      'src/api/internal/profit/backfill/route.ts',
      'src/api/store/sellers/me/products/bulk-stage/route.ts',
      'src/api/store/sellers/me/profit/apply-price/route.ts',
      'src/api/store/sellers/me/profit/fee-estimate/route.ts',
      'src/api/store/sellers/me/profit/route.ts',
      'src/lib/profit-ledger-write.ts',
    ],
  },
  'ml.publish_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'high',
    description: 'Publishes price/catalog changes to Mercado Libre.',
    owners: ['src/api/store/_utils/profit-apply-price.ts'],
  },
  'catalog.inventory_channels_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'high',
    description: 'Inventory modes and per-channel publication controls.',
    owners: [
      'src/api/store/_utils/seller-product-update.ts',
      'src/api/store/listings/route.ts',
    ],
  },
  'catalog.owned_shop_only_enabled': {
    // DEFAULT ON since 2026-07-31 (Daniel's call). The gate has served its only real
    // purpose — letting S2/S3 merge and deploy INERT while a production
    // publishable-key move happened — and there is exactly one user, so staged
    // rollout and no-deploy rollback are worth nothing here while a deploy is 12
    // minutes. It also could not be turned on: Golden Beans is the flag authority in
    // production (`*=golden`) and its Miyagi-flag importer is unwired, so no new
    // Miyagi flag can reach the control plane at all. With no Golden definition and
    // no platform_flags row, this compile default IS the resolved value.
    compileDefault: true,
    // KILLSWITCH, not enablement — the polarity changed with the role. An enablement
    // flag means "not on yet, turning it on is deliberate"; this feature IS on, and
    // turning it OFF is now the deliberate act (the `checkout.stripe_enabled`
    // pattern). Keeps the fail-open invariant "every enablement defaults false"
    // intact rather than carving an exception into it — the frontend's own invariant
    // spec caught this the moment the default flipped.
    polarity: 'killswitch',
    criticality: 'high',
    description:
      'Owned-shop-only buyability: checkout admission proves OPERATING-channel membership instead of ' +
      'marketplace publication. DEFAULT ON — the capability is live. ALSO gates (S3) the acceptance of publish_to_market: null at create ' +
      '(seller-product-create.ts) and publish/unpublish of an EXISTING product in both directions ' +
      '(seller-product-update.ts, D11) — every seller-facing surface this epic adds sits behind the same ' +
      'one flag (D8). Registered in apps/miyagisanchez/lib/flag-catalog.ts too — a key in one repo only ' +
      'is a half-flag.',
    owners: [
      'src/api/store/checkout-admission/[id]/route.ts',
      'src/api/store/_utils/seller-product-create.ts',
      'src/api/store/_utils/seller-product-update.ts',
    ],
  },
  'catalog.bulk_enabled': {
    compileDefault: false,
    polarity: 'killswitch',
    criticality: 'high',
    description: 'Staged bulk catalog mutation; it deliberately fails closed to OFF.',
    owners: [
      'src/api/internal/seller-products/bulk-apply/route.ts',
      'src/api/internal/seller-products/bulk-stage/route.ts',
      'src/api/store/sellers/me/products/bulk-apply/route.ts',
      'src/api/store/sellers/me/products/bulk-stage/route.ts',
    ],
  },
} as const satisfies Record<string, FlagCatalogMetadata>

export type FlagKey = keyof typeof FLAG_CATALOG_DEFINITIONS

export type BackendFlagCatalogEntry = FlagCatalogMetadata & {
  key: FlagKey
}

export const BACKEND_FLAG_CATALOG: readonly BackendFlagCatalogEntry[] = Object.entries(
  FLAG_CATALOG_DEFINITIONS,
)
  .map(([key, metadata]) => ({ key: key as FlagKey, ...metadata }))
  .sort((left, right) => left.key.localeCompare(right.key))

export const BACKEND_FLAG_KEYS: readonly FlagKey[] = BACKEND_FLAG_CATALOG.map(
  (entry) => entry.key,
)

export const BACKEND_FLAG_DEFAULTS: Readonly<Record<FlagKey, boolean>> = Object.freeze(
  Object.fromEntries(
    BACKEND_FLAG_CATALOG.map((entry) => [entry.key, entry.compileDefault]),
  ) as Record<FlagKey, boolean>,
)

export type FlagCallsite = {
  key: string
  owner: string
}

export type FlagInventoryValidation =
  | { ok: true }
  | { ok: false; errors: readonly string[] }

/**
 * Validates an independently derived call-site inventory against the registry.
 * Duplicate, unknown, missing and stale owner rows all fail together rather than
 * yielding a partial catalog that looks complete.
 */
export function validateBackendFlagCallsiteInventory(
  callsites: readonly FlagCallsite[],
): FlagInventoryValidation {
  const errors: string[] = []
  const actual = new Set<string>()
  const expected = new Set(
    BACKEND_FLAG_CATALOG.flatMap((entry) =>
      entry.owners.map((owner) => `${entry.key}\u0000${owner}`),
    ),
  )

  for (const callsite of callsites) {
    const identity = `${callsite.key}\u0000${callsite.owner}`
    if (actual.has(identity)) {
      errors.push(`duplicate callsite: ${callsite.key} @ ${callsite.owner}`)
      continue
    }
    actual.add(identity)
    if (!Object.prototype.hasOwnProperty.call(FLAG_CATALOG_DEFINITIONS, callsite.key)) {
      errors.push(`unknown flag callsite: ${callsite.key} @ ${callsite.owner}`)
    } else if (!expected.has(identity)) {
      errors.push(`unregistered owner: ${callsite.key} @ ${callsite.owner}`)
    }
  }

  for (const identity of expected) {
    if (!actual.has(identity)) {
      const [key, owner] = identity.split('\u0000')
      errors.push(`missing callsite: ${key} @ ${owner}`)
    }
  }

  return errors.length === 0
    ? { ok: true }
    : { ok: false, errors: errors.sort((left, right) => left.localeCompare(right)) }
}
