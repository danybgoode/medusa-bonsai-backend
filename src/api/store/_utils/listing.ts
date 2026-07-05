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
  /** False only when a managed item has run out (reserved/sold). */
  in_stock: boolean
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
  const variants: any[] = product.variants ?? []

  // ── Price (min across all variants) ───────────────────────────────────────
  // Single-variant listings resolve to that one variant's price, byte-for-byte
  // as before. Multi-variant (configurator) listings show the cheapest
  // combination — the "desde $X" price a shop grid needs; the PDP's own
  // price-grid resolves the exact variant+quantity price separately.
  const variantPrices: Array<{ amount: number; currency_code: string }> = variants
    .map((v: any) => {
      const prices: any[] = v?.prices ?? []
      const mxnPrice = prices.find((p: any) => p.currency_code === 'mxn')
      return mxnPrice ?? prices[0]
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
  let availableQuantity: number | null = null
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
  }
  const inStock = !manageInventory || (availableQuantity ?? 0) > 0

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
    category: product.categories?.[0]?.handle ?? null,
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
    status: product.status === 'published' ? 'active' : (product.status as string),
    source_platform: (meta.source_platform as string) ?? null,
    source_url: (meta.source_url as string) ?? null,
    views: (meta.views as number) ?? 0,
    manage_inventory: manageInventory,
    available_quantity: availableQuantity,
    in_stock: inStock,
    created_at: product.created_at as string,
    shop: seller ? toSellerShape(seller) : null,
  }
}
