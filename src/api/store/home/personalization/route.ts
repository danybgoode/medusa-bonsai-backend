import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import type SellerModuleService from '../../../../modules/seller/service'
import { supabaseRead } from '../../_utils/supabase-read'
import { bearerToken, verifyClerkJwt } from '../../_utils/clerk-verify'

/**
 * GET /store/home/personalization
 *
 * Marketplace-static-shell · Sprint 3 (Phase 2). The homepage is a static CDN asset
 * (no Vercel function), so the signed-in "welcome back" personalization is served from
 * here (Cloud Run) and the S4 client islands fetch it after hydration. READ-ONLY — no
 * mutation. Reproduces the read set the old `app/page.tsx` signed-in block ran
 * (git: a1e6ea4^:app/page.tsx).
 *
 * The endpoint returns DATA only — no es-MX copy. The S4 island runs the frontend's
 * pure `deriveOfferAlerts(offerAlertInputs)` to produce the Spanish alert copy, so the
 * copy stays single-source in the frontend (AGENTS rule #5).
 *
 * Auth = a CRYPTOGRAPHICALLY VERIFIED Clerk JWT (jose JWKS — see clerk-verify.ts), not
 * the decode-only `extractClerkUserId`. An unauth'd/invalid call → 401 (never partial data).
 */

// ── Wire types (data-only; field names match the frontend derivers so S4 can feed them straight in) ──

/** Mirrors the frontend `RecentFavorite` (lib/home-favorites.ts). */
export interface RecentFavorite {
  medusaId: string
  title: string
  priceCents: number | null
  currency: string
  condition: string | null
  location: string | null
  imageUrl: string | null
  /** Snapshot of `price_cents` at favorite-time (`marketplace_favorites.price_cents_at_save`,
   *  written by `app/api/favorites/route.ts` on favorite). `null` for favorites saved before
   *  that column existed — the S2.2 price-drop badge just degrades to "no badge" then. */
  priceCentsAtSave: number | null
}

/** Data subset of the frontend `OfferAlertInput` (lib/home-offer-alert.ts) — no copy. */
export interface OfferAlertInputData {
  offerId: string
  conversationId: string | null
  perspective: 'buyer' | 'seller'
  status: string
  expiresAt: string
  amountCents: number
  currency: string
  listingTitle: string
  shopName: string | null
}

export interface SellerSnapshot {
  shopName: string
  visitas: number
  ofertasNuevas: number
}

export interface HomePersonalization {
  recentFavorites: RecentFavorite[]
  offerAlertInputs: OfferAlertInputData[]
  sellerSnapshot: SellerSnapshot | null
  hasShop: boolean
}

const EMPTY: HomePersonalization = {
  recentFavorites: [],
  offerAlertInputs: [],
  sellerSnapshot: null,
  hasShop: false,
}

// A to-one Supabase join arrives as either the object or a one-element array.
function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

// ── Section reads (each guarded so one failure degrades to empty, never a 500) ──

type SupabaseLike = typeof supabaseRead
type ShopRow = { id: string; slug: string; name: string }

async function readShop(supabase: SupabaseLike, clerkUserId: string): Promise<ShopRow | null> {
  try {
    const { data, error } = await supabase
      .from('marketplace_shops')
      .select('id, slug, name')
      .eq('clerk_user_id', clerkUserId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    // Supabase reports query errors in-band (no throw) — surface it so a transient DB
    // failure isn't silently read as "not a seller" (hasShop=false for a real seller).
    if (error) {
      console.error('[home-personalization] shop read error:', error)
      return null
    }
    return (data as ShopRow | null) ?? null
  } catch (e) {
    console.error('[home-personalization] shop read failed:', e)
    return null
  }
}

interface FavoriteRow {
  price_cents_at_save: number | null
  marketplace_listings: {
    medusa_product_id: string | null
    title: string
    price_cents: number | null
    currency: string | null
    condition: string | null
    location: string | null
    images: Array<{ url: string }> | null
    status: string
  } | null
}

/** Newest `n` active favorites — ported from frontend lib/home-favorites.ts. */
async function readRecentFavorites(
  supabase: SupabaseLike,
  clerkUserId: string,
  n = 3,
): Promise<RecentFavorite[]> {
  try {
    const { data, error } = await supabase
      .from('marketplace_favorites')
      .select(`
        price_cents_at_save,
        marketplace_listings (
          medusa_product_id, title, price_cents, currency, condition, location, images, status
        )
      `)
      .eq('clerk_user_id', clerkUserId)
      .order('created_at', { ascending: false })
      .limit(20)
    if (error) throw error
    return ((data ?? []) as unknown as FavoriteRow[])
      .filter((row): row is FavoriteRow & { marketplace_listings: NonNullable<FavoriteRow['marketplace_listings']> } =>
        !!row.marketplace_listings && row.marketplace_listings.status === 'active' && !!row.marketplace_listings.medusa_product_id)
      .slice(0, n)
      .map((row) => ({
        medusaId: row.marketplace_listings.medusa_product_id!,
        title: row.marketplace_listings.title,
        priceCents: row.marketplace_listings.price_cents,
        currency: (row.marketplace_listings.currency ?? 'MXN').toUpperCase(),
        condition: row.marketplace_listings.condition,
        location: row.marketplace_listings.location,
        imageUrl: row.marketplace_listings.images?.[0]?.url ?? null,
        priceCentsAtSave: row.price_cents_at_save,
      }))
  } catch (e) {
    console.error('[home-personalization] favorites read failed:', e)
    return []
  }
}

type OfferShop = { name?: string | null }
type OfferListing = {
  title?: string | null
  currency?: string | null
  marketplace_shops?: OfferShop | OfferShop[] | null
}
type OfferRow = {
  id: string
  offer_amount_cents: number
  status: string
  expires_at: string
  marketplace_listings?: OfferListing | OfferListing[] | null
}

/**
 * Buyer + seller pending-offer inputs (data only — S4 derives the alert copy).
 * Buyer offers: by `buyer_clerk_user_id`. Seller offers: by the caller's own
 * Supabase `shop_id`. Conversation ids resolved so S4's alerts deep-link to the thread.
 */
async function readOfferAlertInputs(
  supabase: SupabaseLike,
  clerkUserId: string,
  shop: ShopRow | null,
): Promise<OfferAlertInputData[]> {
  try {
    const [buyerRes, sellerRes] = await Promise.all([
      supabase
        .from('marketplace_offers')
        .select('id, offer_amount_cents, status, expires_at, marketplace_listings!inner(title, currency, marketplace_shops(name))')
        .eq('buyer_clerk_user_id', clerkUserId)
        .eq('status', 'pending')
        .order('expires_at', { ascending: true })
        .limit(10),
      shop
        ? supabase
            .from('marketplace_offers')
            .select('id, offer_amount_cents, status, expires_at, marketplace_listings!inner(title, currency)')
            .eq('shop_id', shop.id)
            .eq('status', 'pending')
            .order('expires_at', { ascending: true })
            .limit(10)
        : Promise.resolve({ data: [] as unknown[] }),
    ])

    const buyerErr = (buyerRes as { error?: unknown }).error
    const sellerErr = (sellerRes as { error?: unknown }).error
    if (buyerErr) console.error('[home-personalization] buyer offers read error:', buyerErr)
    if (sellerErr) console.error('[home-personalization] seller offers read error:', sellerErr)
    const buyerOffers = ((buyerRes as { data?: unknown }).data ?? []) as OfferRow[]
    const sellerOffers = ((sellerRes as { data?: unknown }).data ?? []) as OfferRow[]

    // Resolve conversation ids for deep-links.
    const offerIds = [...buyerOffers, ...sellerOffers].map((o) => o.id)
    let convByOfferId: Record<string, string> = {}
    if (offerIds.length > 0) {
      const { data: convs, error: convErr } = await supabase
        .from('marketplace_conversations')
        .select('id, offer_id')
        .in('offer_id', offerIds)
      if (convErr) console.error('[home-personalization] conversations read error:', convErr)
      convByOfferId = Object.fromEntries(
        ((convs ?? []) as Array<{ id: string; offer_id: string | null }>)
          .filter((c) => c.offer_id)
          .map((c) => [c.offer_id as string, c.id]),
      )
    }

    const buyerInputs: OfferAlertInputData[] = buyerOffers.map((o) => {
      const listing = one(o.marketplace_listings)
      return {
        offerId: o.id,
        conversationId: convByOfferId[o.id] ?? null,
        perspective: 'buyer',
        status: o.status,
        expiresAt: o.expires_at,
        amountCents: o.offer_amount_cents,
        currency: (listing?.currency ?? 'MXN').toUpperCase(),
        listingTitle: listing?.title ?? '',
        shopName: one(listing?.marketplace_shops)?.name ?? null,
      }
    })
    const sellerInputs: OfferAlertInputData[] = sellerOffers.map((o) => {
      const listing = one(o.marketplace_listings)
      return {
        offerId: o.id,
        conversationId: convByOfferId[o.id] ?? null,
        perspective: 'seller',
        status: o.status,
        expiresAt: o.expires_at,
        amountCents: o.offer_amount_cents,
        currency: (listing?.currency ?? 'MXN').toUpperCase(),
        listingTitle: listing?.title ?? '',
        shopName: null,
      }
    })
    return [...buyerInputs, ...sellerInputs]
  } catch (e) {
    console.error('[home-personalization] offers read failed:', e)
    return []
  }
}

/** A remoteQuery-shaped dep — only `.graph()` is used here. */
export interface RemoteQueryLike {
  graph: (args: unknown) => Promise<{ data?: unknown[] }>
}

type SellerRow = { id: string; name: string }

/**
 * The caller's CANONICAL shop = the Medusa seller (`listSellers({clerk_user_id})`,
 * the same source `/store/sellers/me` uses). This — not the best-effort Supabase
 * `marketplace_shops` mirror — must decide `hasShop`: the mirror sync is fire-and-
 * forget (`ensureSupabaseShopMirror(...).catch(() => {})` on the frontend), so a
 * real seller whose mirror row is missing/stale would otherwise be told "open your
 * store" (the recruit card) on the homepage.
 */
async function readSeller(
  sellerService: Pick<SellerModuleService, 'listSellers'>,
  clerkUserId: string,
): Promise<SellerRow | null> {
  try {
    const sellers = await sellerService.listSellers({ clerk_user_id: clerkUserId })
    const seller = sellers?.[0]
    return seller ? { id: seller.id, name: seller.name } : null
  } catch (e) {
    console.error('[home-personalization] seller read failed:', e)
    return null
  }
}

/** Sum the caller's listings' view counts (Medusa-native: seller → products.metadata.views). */
async function readSellerVisitas(
  seller: SellerRow,
  remoteQuery: RemoteQueryLike,
): Promise<number> {
  try {
    const { data } = await remoteQuery.graph({
      entity: 'seller',
      fields: ['id', 'products.metadata'],
      filters: { id: seller.id },
    })
    let total = 0
    for (const row of (data ?? []) as Array<{ products?: Array<{ metadata?: Record<string, unknown> }> }>) {
      for (const p of row.products ?? []) {
        const v = p.metadata?.views
        if (typeof v === 'number') total += v
      }
    }
    return total
  } catch (e) {
    console.error('[home-personalization] visitas read failed:', e)
    return 0
  }
}

// ── Orchestration (injectable deps so the unit spec can mock cleanly) ──

export interface PersonalizationDeps {
  supabase: SupabaseLike
  sellerService: Pick<SellerModuleService, 'listSellers'>
  remoteQuery: RemoteQueryLike
  clerkUserId: string
}

export async function buildHomePersonalization(deps: PersonalizationDeps): Promise<HomePersonalization> {
  const { supabase, sellerService, remoteQuery, clerkUserId } = deps

  // Canonical ownership from the Medusa seller; the Supabase mirror row is read only
  // for the seller-offers join (`shop.id`) + a shop-name source — it never decides
  // `hasShop` (see readSeller).
  const [seller, shop] = await Promise.all([
    readSeller(sellerService, clerkUserId),
    readShop(supabase, clerkUserId),
  ])
  const [recentFavorites, offerAlertInputs] = await Promise.all([
    readRecentFavorites(supabase, clerkUserId, 3),
    readOfferAlertInputs(supabase, clerkUserId, shop),
  ])

  let sellerSnapshot: SellerSnapshot | null = null
  if (seller) {
    // ofertasNuevas needs the mirror's shop.id for the seller-offers query; if the
    // mirror is missing it degrades to 0, but the snapshot still renders (no recruit).
    const ofertasNuevas = offerAlertInputs.filter((o) => o.perspective === 'seller').length
    const visitas = await readSellerVisitas(seller, remoteQuery)
    sellerSnapshot = { shopName: shop?.name ?? seller.name, visitas, ofertasNuevas }
  }

  return { recentFavorites, offerAlertInputs, sellerSnapshot, hasShop: !!seller }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const verified = await verifyClerkJwt(bearerToken(req))
  if (!verified) {
    return res.status(401).json({ message: 'Authentication required' })
  }

  try {
    const sellerService = req.scope.resolve(SELLER_MODULE) as SellerModuleService
    const remoteQuery = req.scope.resolve('remoteQuery') as RemoteQueryLike
    const data = await buildHomePersonalization({
      supabase: supabaseRead,
      sellerService,
      remoteQuery,
      clerkUserId: verified.sub,
    })
    return res.json(data)
  } catch (e) {
    // Never leak a 500 to the static-shell islands — degrade to empty personalization.
    console.error('[home-personalization] unexpected failure:', e)
    return res.json(EMPTY)
  }
}
