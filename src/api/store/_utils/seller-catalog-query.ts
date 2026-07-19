/**
 * Shared seller-catalog filter/resolve logic — extracted from
 * `GET /store/sellers/me/products` (catalog-management Sprint 1 · 1.2) so the
 * bulk-stage route (Sprint 3 · 3.1) can resolve "every product matching the
 * seller's active filter" through the EXACT same filter/sort/status-derive
 * code the table itself uses — a bulk action can never target a different
 * set of products than what the seller sees on screen.
 *
 * Returns the full matching set, unpaginated — callers slice for a page
 * (GET route) or cap-and-use-directly for a bulk batch (bulk-stage route).
 */
import { QueryContext } from '@medusajs/framework/utils'
import { MERCADOLIBRE_MODULE } from '../../../modules/mercadolibre'
import MercadolibreModuleService from '../../../modules/mercadolibre/service'
import { toListingShape, type ListingShape } from './listing'
import { isHiddenCatalogProduct } from './support'

export interface CatalogFilterParams {
  q?: string
  category?: string
  channel?: 'miyagi' | 'ml'
  stock?: 'in_stock' | 'agotado' | 'unlimited'
  status?: 'activo' | 'agotado' | 'borrador' | 'pausado' | 'sobre_pedido'
  sort?: 'recent' | 'title' | 'price_asc' | 'price_desc'
  /**
   * Explicit product ids to scope to (bulk-stage's manual-selection mode) —
   * intersected with the seller's own linked ids exactly like every other
   * filter here, so a request can never target another seller's product.
   * When present, no other filter narrows the DB fetch further (the caller
   * already knows exactly which rows it wants); `q`/`category` are ignored
   * in this mode.
   */
  ids?: string[]
}

export interface CatalogPair {
  raw: any
  listing: ListingShape
  /** Whether this product has a live (non-closed) Mercado Libre link — lets a
   * bulk `publish_channel` action for the 'ml' channel show an accurate
   * before-state (catalog-management S3 · 3.2). */
  mlLinked: boolean
}

export type CatalogStatusCounts = {
  activo: number
  agotado: number
  borrador: number
  pausado: number
  sobre_pedido: number
}

export interface CatalogQueryResult {
  /** Filtered + sorted, NOT paginated. */
  pairs: CatalogPair[]
  mlLinkedIds: Set<string>
  statusCounts: CatalogStatusCounts
}

const isSobrePedido = (l: { manage_inventory: boolean; allow_backorder: boolean }) =>
  l.manage_inventory && l.allow_backorder

/**
 * The seller's own product ids — the SAME ownership check the single-row
 * routes' `resolveOwnership()` runs (`sellers/me/products/[id]/route.ts`,
 * `internal/seller-products/[id]/route.ts`), extracted so a bulk-apply route
 * can enforce it per item too. `updateSellerProduct()` itself does NOT check
 * ownership (its own doc comment: "Callers are responsible for
 * authentication + ownership BEFORE calling this") — every call site must.
 *
 * Filters out null/undefined array entries before mapping: `remoteQuery`'s
 * `seller → products.id` link can return a sparse array slot (not just omit
 * the row) once a linked product's `deleted_at` is set by
 * `productService.softDeleteProducts()` — the module link row itself
 * survives the soft-delete, but the joined product entity resolves to
 * null/undefined for that slot. A bare `.map((p) => p.id)` then throws
 * "Cannot read properties of undefined (reading 'id')" on the very next
 * catalog fetch after ANY soft-delete — a real, live production incident
 * found via the catalog-management epic's Sprint 3 smoke test (this exact
 * `.map()` shape pre-dates Sprint 3 as inline code in the S1 GET route; the
 * extraction here didn't introduce the bug, just gave it one call site to
 * fix instead of several.
 */
export interface ResolveSellerProductIdsOptions {
  /**
   * Order ownership must survive a listing soft-delete. Medusa only applies
   * top-level `withDeleted` to nested relations when that relation has a
   * QueryContext, so both pieces below are load-bearing.
   */
  includeDeleted?: boolean
}

export interface SellerProductMetadataRecord {
  id: string
  metadata?: Record<string, unknown> | null
}

type SellerProductSlot = SellerProductMetadataRecord | null | undefined
type GraphQueryLike = {
  graph: (query: Record<string, unknown>) => Promise<{ data?: unknown[] }>
}

function isResolvedSellerProduct(product: SellerProductSlot): product is SellerProductMetadataRecord {
  return product != null && typeof product.id === 'string'
}

function productRecords(rows: unknown[] | undefined): SellerProductMetadataRecord[] {
  const products = (
    rows?.[0] as { products?: SellerProductSlot[] } | undefined
  )?.products ?? []
  return products.filter(isResolvedSellerProduct)
}

function sellerProductGraphQuery(
  sellerId: string,
  fields: string[],
  options: ResolveSellerProductIdsOptions = {},
) {
  const query: Record<string, unknown> = {
    entity: 'seller',
    fields: ['id', ...fields],
    filters: { id: sellerId },
  }

  if (options.includeDeleted) {
    query.context = {
      products: QueryContext({}),
    }
    query.withDeleted = true
  }

  return query
}

async function graphSellerProductRecords(
  remoteQuery: GraphQueryLike,
  sellerId: string,
  fields: string[],
  options: ResolveSellerProductIdsOptions = {},
): Promise<SellerProductMetadataRecord[]> {
  const { data: rows } = await remoteQuery.graph({
    ...sellerProductGraphQuery(sellerId, fields, options),
  })
  return productRecords(rows)
}

export async function resolveSellerProductIds(
  scope: any,
  sellerId: string,
  options: ResolveSellerProductIdsOptions = {},
): Promise<Set<string>> {
  const remoteQuery = scope.resolve('remoteQuery') as GraphQueryLike
  const products = await graphSellerProductRecords(remoteQuery, sellerId, ['products.id'], options)
  return new Set(products.map((product) => product.id))
}

/**
 * The checkout support resolver still receives Medusa's legacy callable
 * remote-query seam as an injected dependency. Keep its row parsing on the
 * same typed null filter rather than duplicating the unsafe map locally.
 */
export async function resolveSellerProductIdsFromRemoteQuery(
  remoteQuery: (query: Record<string, unknown>) => Promise<{ data?: unknown[] }>,
  sellerId: string,
): Promise<Set<string>> {
  const { data: rows } = await remoteQuery({
    seller: {
      fields: ['id', 'products.id'],
      variables: { filters: { id: sellerId } },
    },
  })
  return new Set(productRecords(rows).map((product) => product.id))
}

/**
 * Metadata consumers need the linked records, not only their ids. This is the
 * sole typed escape hatch for those reads; sparse relation slots are removed
 * before callers can find/iterate/access metadata.
 */
export async function resolveSellerProductMetadataRecords(
  remoteQuery: GraphQueryLike,
  sellerId: string,
): Promise<SellerProductMetadataRecord[]> {
  return graphSellerProductRecords(
    remoteQuery,
    sellerId,
    ['products.id', 'products.metadata'],
  )
}

export async function querySellerCatalog(
  scope: any,
  seller: { id: string; slug?: string },
  filters: CatalogFilterParams,
): Promise<CatalogQueryResult> {
  const remoteQuery = scope.resolve('remoteQuery')
  const linkedIdsSet = await resolveSellerProductIds(scope, seller.id)
  const linkedIds = [...linkedIdsSet]

  if (linkedIds.length === 0) {
    return { pairs: [], mlLinkedIds: new Set(), statusCounts: { activo: 0, agotado: 0, borrador: 0, pausado: 0, sobre_pedido: 0 } }
  }

  let idFilter: string[]
  const dbFilters: Record<string, unknown> = {}
  if (filters.ids && filters.ids.length > 0) {
    idFilter = filters.ids.filter((id) => linkedIdsSet.has(id))
    if (idFilter.length === 0) {
      return { pairs: [], mlLinkedIds: new Set(), statusCounts: { activo: 0, agotado: 0, borrador: 0, pausado: 0, sobre_pedido: 0 } }
    }
  } else {
    idFilter = linkedIds
    if (filters.q) dbFilters.title = { $ilike: `%${filters.q}%` }
    if (filters.category) dbFilters.categories = { handle: filters.category }
  }
  dbFilters.id = idFilter

  const { data: matchedProductsRaw } = await remoteQuery.graph({
    entity: 'product',
    fields: [
      'id', 'title', 'description', 'status', 'metadata', 'weight', 'created_at',
      'variants.*', 'variants.sku', 'variants.prices.*',
      'variants.inventory_items.inventory.location_levels.stocked_quantity',
      'variants.inventory_items.inventory.location_levels.reserved_quantity',
      'images.*',
      'categories.*',
      'type.*',
      'tags.*',
    ],
    filters: dbFilters,
    pagination: { take: Math.min(idFilter.length, 2000), skip: 0 },
  })

  let pairs: CatalogPair[] = (matchedProductsRaw ?? [])
    .filter((product: { metadata?: unknown }) => !isHiddenCatalogProduct(product.metadata))
    .map((product) => ({ raw: product, listing: toListingShape(product, seller), mlLinked: false }))

  const mlService: MercadolibreModuleService = scope.resolve(MERCADOLIBRE_MODULE)
  const mlLinks = await mlService.listProductMlLinks({ product_id: pairs.map((p) => p.listing.id) })
  const mlLinkedIds = new Set(
    mlLinks
      .filter((link: { metadata?: Record<string, unknown> | null }) => link.metadata?.ml_status !== 'closed')
      .map((link: { product_id: string }) => link.product_id),
  )
  pairs = pairs.map((p) => ({ ...p, mlLinked: mlLinkedIds.has(p.listing.id) }))

  if (filters.channel === 'ml' || filters.channel === 'miyagi') {
    pairs = pairs.filter((p) => (filters.channel === 'ml' ? mlLinkedIds.has(p.listing.id) : !mlLinkedIds.has(p.listing.id)))
  }

  if (filters.stock === 'in_stock') pairs = pairs.filter((p) => p.listing.in_stock)
  else if (filters.stock === 'agotado') pairs = pairs.filter((p) => p.listing.manage_inventory && !p.listing.in_stock)
  else if (filters.stock === 'unlimited') pairs = pairs.filter((p) => !p.listing.manage_inventory)

  const statusCounts: CatalogStatusCounts = { activo: 0, agotado: 0, borrador: 0, pausado: 0, sobre_pedido: 0 }
  for (const p of pairs) {
    if (p.listing.status === 'paused') statusCounts.pausado++
    else if (p.listing.status === 'active') {
      if (isSobrePedido(p.listing)) statusCounts.sobre_pedido++
      else statusCounts[p.listing.in_stock ? 'activo' : 'agotado']++
    } else statusCounts.borrador++
  }

  if (filters.status === 'activo') {
    pairs = pairs.filter((p) => p.listing.status === 'active' && p.listing.in_stock && !isSobrePedido(p.listing))
  } else if (filters.status === 'agotado') {
    pairs = pairs.filter((p) => p.listing.status === 'active' && !p.listing.in_stock && !isSobrePedido(p.listing))
  } else if (filters.status === 'sobre_pedido') {
    pairs = pairs.filter((p) => p.listing.status === 'active' && isSobrePedido(p.listing))
  } else if (filters.status === 'borrador') pairs = pairs.filter((p) => p.listing.status === 'draft')
  else if (filters.status === 'pausado') pairs = pairs.filter((p) => p.listing.status === 'paused')

  const sort = filters.sort ?? 'recent'
  pairs.sort((a, b) => {
    if (sort === 'title') return a.listing.title.localeCompare(b.listing.title)
    if (sort === 'price_asc') return (a.listing.price_cents ?? Infinity) - (b.listing.price_cents ?? Infinity)
    if (sort === 'price_desc') return (b.listing.price_cents ?? -Infinity) - (a.listing.price_cents ?? -Infinity)
    return new Date(b.listing.created_at).getTime() - new Date(a.listing.created_at).getTime()
  })

  return { pairs, mlLinkedIds, statusCounts }
}
