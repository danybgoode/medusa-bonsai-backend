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

export function toListingShape(product: any, seller?: any): ListingShape {
  const meta = (product.metadata ?? {}) as Record<string, unknown>
  const variant = product.variants?.[0]
  const mxnPrice = variant?.prices?.find((p: any) => p.currency_code === 'mxn')
  const priceObj = mxnPrice ?? variant?.prices?.[0]
  const fallbackPrice = typeof meta.price_cents === 'number' ? meta.price_cents : null

  // ── Stock (Medusa Inventory) ──────────────────────────────────────────────
  // Managed (physical) variants carry inventory items with location levels;
  // available = Σ(stocked − reserved). Unmanaged legacy items (services, autos
  // pre-backfill, etc.) have no inventory item → treated as unlimited / in stock.
  const manageInventory = !!variant?.manage_inventory
  let availableQuantity: number | null = null
  if (manageInventory) {
    const levels: any[] = (variant?.inventory_items ?? [])
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
