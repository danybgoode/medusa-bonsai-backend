/**
 * Shared listing normalisation helper.
 *
 * Converts a raw Medusa Product + optional Seller into the public listing
 * shape used by all /store/listings/* endpoints and the UCP catalog.
 *
 * NOTE: The listings endpoint currently loads all products into memory and
 * filters/paginates in-process. This is fine up to ~500 listings. Beyond that,
 * push filters into the remoteQuery call and add a proper count query.
 */

import { splitCategories } from './category-split'

export interface ListingShape {
  id: string
  shop_id: string
  medusa_product_id: string
  title: string
  description: string | null
  price_cents: number | null
  currency: string
  condition: string | null
  listing_type: string
  category: string | null
  /** Seller-defined collection handles this listing belongs to (own-shop-premium-presentation S2). */
  collections: string[]
  state: string | null
  municipio: string | null
  location: string | null
  /** Category/type-specific structured attributes (brand, size, color, year, km…). */
  attrs: Record<string, unknown>
  /** Native Medusa weight in grams (physical products). */
  weight_grams: number | null
  /** Auto-generated SKU from the default variant. */
  sku: string | null
  metadata: Record<string, unknown>
  images: Array<{ url: string; alt: string | null }>
  tags: string[]
  status: string
  source_platform: string | null
  source_url: string | null
  views: number
  /** Whether the listing's variant tracks finite stock (physical products). */
  manage_inventory: boolean
  /** Available units (stocked − reserved) for managed items; null = unlimited. */
  available_quantity: number | null
  /**
   * Reserved units (in-flight orders) for managed items; null = unlimited.
   * Raw, never clamped — catalog-management epic, Sprint 2 · Story 2.1
   * ("tracked … available vs reservado").
   */
  reserved_quantity: number | null
  /** False only when a managed item has run out (reserved/sold). */
  in_stock: boolean
  /**
   * Native Medusa "sobre pedido" flag — orders past zero stock are still
   * accepted (Medusa's own `reserveInventoryStep`/`completeCartWorkflow`
   * already honor this natively, no custom checkout code needed). Only
   * meaningful alongside `manage_inventory: true` (catalog-management S2 ·
   * Story 2.1).
   */
  allow_backorder: boolean
  /**
   * Seller's estimated dispatch note for a backorder ("sobre pedido") listing
   * — e.g. '1-3d'. Per-listing, distinct from the shop-wide "Tiempo de
   * procesamiento" setting (`marketplace_shops.metadata.settings.orders`);
   * null when not in backorder mode or unset (catalog-management S2 · 2.1).
   */
  dispatch_estimate: string | null
  created_at: string
  shop: SellerShape | null
}

export interface SellerShape {
  id: string
  slug: string
  name: string
  description: string | null
  location: string | null
  logo_url: string | null
  clerk_user_id: string | null
  verified: boolean
  source: string | null
  source_url: string | null
  metadata: unknown
  created_at: string
  custom_domain: null
  custom_domain_verified: false
  custom_domain_vercel_ok: false
}

/**
 * Strip seller secrets before metadata is exposed via the public Store API.
 * MercadoPago marketplace OAuth stores the seller's access/refresh tokens in
 * settings.mercadopago — these must never reach the storefront. Safe status
 * fields (connected/enabled/live_mode/user_id/public_key) are retained so the
 * frontend can gate the MP button.
 */
function sanitizeSellerMetadata(metadata: any): any {
  if (!metadata || typeof metadata !== 'object') return metadata ?? null
  const settings = (metadata as any).settings
  if (!settings || typeof settings !== 'object' || !settings.mercadopago) return metadata
  const { access_token, refresh_token, ...safeMp } = settings.mercadopago
  return { ...metadata, settings: { ...settings, mercadopago: safeMp } }
}

export function toSellerShape(seller: any): SellerShape {
  return {
    id: seller.id,
    slug: seller.slug,
    name: seller.name,
    description: seller.description ?? null,
    location: seller.location ?? null,
    logo_url: seller.logo_url ?? null,
    clerk_user_id: seller.clerk_user_id ?? null,
    verified: seller.verified ?? false,
    source: seller.source ?? null,
    source_url: seller.source_url ?? null,
    metadata: sanitizeSellerMetadata(seller.metadata),
    created_at: seller.created_at,
    custom_domain: null,
    custom_domain_verified: false,
    custom_domain_vercel_ok: false,
  }
}

/**
 * Whether a listing is an admin/seller pin — `metadata.featured === true`.
 *
 * Mirrors the frontend `isPinned` (lib/home-curation.ts): a pin is the strict
 * boolean `true`, never the string `"true"` or any truthy value. Backs the
 * `/store/listings?featured=true` read-filter (seleccion-pins-authoritative S2.1)
 * so the homepage can fetch pins explicitly, regardless of freshness.
 */
export function isFeaturedPin(l: { metadata?: Record<string, unknown> | null }): boolean {
  return l.metadata?.featured === true
}

export function toListingShape(product: any, seller?: any): ListingShape {
  const meta = (product.metadata ?? {}) as Record<string, unknown>
  // Exclude any variant flagged `metadata.disabled` (hidden/non-purchasable)
  // so its price can never deflate the "desde $X" display. Nothing in this
  // codebase sets this today (an earlier option-dimensions design that did
  // was replaced — see applyOptionDimensions() in seller-product-update.ts —
  // with an outright refusal instead of an in-place disable, once Medusa's
  // variant-options constraint made preserving the old variant unsafe), but
  // the filter is defensive/cheap to keep for any future per-variant
  // disable. Mirrors the same filter in listings/[id]/price-grid/route.ts.
  const variants: any[] = (product.variants ?? []).filter((v: any) => v?.metadata?.disabled !== true)

  // ── Price (min across all variants) ───────────────────────────────────────
  // Single-variant listings resolve to that one variant's price, byte-for-byte
  // as before. Multi-variant (configurator) listings show the cheapest
  // combination — the "desde $X" price a shop grid needs; the PDP's own
  // price-grid resolves the exact variant+quantity price separately.
  const variantPrices: Array<{ amount: number; currency_code: string }> = variants
    .map((v: any) => {
      const prices: any[] = v?.prices ?? []
      const mxnPrices = prices.filter((p: any) => p.currency_code === 'mxn')
      // A variant can carry MULTIPLE mxn prices (Story 2.2's quantity
      // tiers) — the display/"desde $X" price must be the base (qty=1)
      // entry, not whichever tier the DB happens to return first. Picking
      // array-order-first could show a bulk-discount tier as if it were the
      // starting price (cross-agent review catch, 2026-07-05).
      const basePrice = mxnPrices.length > 0
        ? mxnPrices.reduce((lowest, p) => ((p.min_quantity ?? 1) < (lowest.min_quantity ?? 1) ? p : lowest))
        : undefined
      return basePrice ?? prices[0]
    })
    .filter((p): p is { amount: number; currency_code: string } => !!p)
  const priceObj = variantPrices.length > 0
    ? variantPrices.reduce((min, p) => (p.amount < min.amount ? p : min))
    : undefined
  const fallbackPrice = typeof meta.price_cents === 'number' ? meta.price_cents : null

  // ── Stock (Medusa Inventory, summed across ALL variants) ──────────────────
  // Managed (physical) variants carry inventory items with location levels;
  // available = Σ(stocked − reserved) across every variant, not just one —
  // mirrors getProductAvailableQuantity() in inventory.ts. Unmanaged legacy
  // items (services, autos pre-backfill, etc.) have no inventory item →
  // treated as unlimited / in stock.
  const manageInventory = variants.some((v: any) => !!v?.manage_inventory)
  const allowBackorder = variants.some((v: any) => !!v?.allow_backorder)
  let availableQuantity: number | null = null
  let reservedQuantity: number | null = null
  if (manageInventory) {
    const levels: any[] = variants
      .filter((v: any) => v?.manage_inventory)
      .flatMap((v: any) => v?.inventory_items ?? [])
      .flatMap((ii: any) => ii?.inventory?.location_levels ?? [])
    availableQuantity = levels.reduce(
      (sum: number, lvl: any) =>
        sum + (Number(lvl?.stocked_quantity ?? 0) - Number(lvl?.reserved_quantity ?? 0)),
      0,
    )
    reservedQuantity = levels.reduce(
      (sum: number, lvl: any) => sum + Number(lvl?.reserved_quantity ?? 0),
      0,
    )
  }
  // `in_stock`'s meaning is unchanged by backorder support — it's still the
  // raw stocked-minus-reserved signal. A backorder ("sobre pedido") listing
  // that hits in_stock:false is NOT hidden/blocked; that combination is what
  // the frontend deriver reads as "sobre pedido," never "agotado" (S2 · 2.1).
  const inStock = !manageInventory || (availableQuantity ?? 0) > 0

  const { platformCategory, collections } = splitCategories(product.categories, seller?.slug)

  return {
    id: product.id,
    shop_id: seller?.id ?? '',
    medusa_product_id: product.id,
    title: product.title,
    description: product.description ?? null,
    price_cents: priceObj?.amount ?? fallbackPrice,
    currency: (priceObj?.currency_code ?? (meta.currency as string | undefined) ?? 'mxn').toUpperCase(),
    condition: (meta.condition as string) ?? null,
    listing_type: (product.type?.value ?? (meta.listing_type as string | undefined) ?? 'product') as string,
    category: platformCategory?.handle ?? null,
    collections: collections.map((c) => c.handle),
    state: (meta.state as string) ?? null,
    municipio: (meta.municipio as string) ?? null,
    location: (meta.location as string) ?? null,
    attrs: (meta.attrs as Record<string, unknown>) ?? {},
    weight_grams: typeof product.weight === 'number' ? product.weight : null,
    sku: (variants[0]?.sku as string) ?? null,
    metadata: meta,
    images: (product.images ?? []).map((img: any) => ({
      url: img.url,
      alt: (img.metadata?.alt as string) ?? null,
    })),
    tags: (product.tags ?? []).map((t: any) => t.value as string),
    // A paused listing stays Medusa-native `status: 'draft'` (pausing never
    // unpublishes into a *different* native status) — `metadata.paused` is the
    // only thing that distinguishes it from a never-published draft. Set/cleared
    // by the seller PATCH route (`app/api/sell/listing/[id]/route.ts`) in the
    // same call that flips `status`, so the two can't drift apart.
    status: product.status === 'published'
      ? 'active'
      : product.status === 'draft' && meta.paused === true
        ? 'paused'
        : (product.status as string),
    source_platform: (meta.source_platform as string) ?? null,
    source_url: (meta.source_url as string) ?? null,
    views: (meta.views as number) ?? 0,
    manage_inventory: manageInventory,
    available_quantity: availableQuantity,
    reserved_quantity: reservedQuantity,
    in_stock: inStock,
    allow_backorder: allowBackorder,
    dispatch_estimate: (meta.dispatch_estimate as string) ?? null,
    created_at: product.created_at as string,
    shop: seller ? toSellerShape(seller) : null,
  }
}

/**
 * Seller-private variant-metadata keys that must never reach a PUBLIC read.
 * `unit_cost_cents` is the seller's COGS (profit-analyzer S1 · US-1);
 * `ml_price_cents` is the optional Mercado Libre price override
 * (catalog-management epic, Sprint 2 · Story 2.3) — only the Clerk-authed
 * seller-scoped GET and the internal ML-publish route may read it. Any route
 * that serializes RAW variants (rather than through `toListingShape`, which
 * never emits variant metadata) must pass its products through
 * `stripPrivateVariantMetadata` before responding. Add future private keys
 * here, not at call sites.
 */
const PRIVATE_VARIANT_METADATA_KEYS = ['unit_cost_cents', 'ml_price_cents'] as const

/**
 * Deep-copy-free scrub of seller-private keys from every variant's metadata
 * on a raw product row (public keys like `disabled` survive — the storefront
 * filters on them). Returns new product/variant/metadata objects; never
 * mutates the input rows.
 */
export function stripPrivateVariantMetadata<T extends { variants?: any[] | null }>(product: T): T {
  const variants = product.variants
  if (!Array.isArray(variants) || variants.length === 0) return product
  return {
    ...product,
    variants: variants.map((v) => {
      const meta = v?.metadata as Record<string, unknown> | null | undefined
      if (!meta || typeof meta !== 'object') return v
      if (!PRIVATE_VARIANT_METADATA_KEYS.some((k) => k in meta)) return v
      const next = { ...meta }
      for (const k of PRIVATE_VARIANT_METADATA_KEYS) delete next[k]
      return { ...v, metadata: next }
    }),
  }
}
