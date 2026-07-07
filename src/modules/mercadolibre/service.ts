import { MedusaService } from '@medusajs/framework/utils'
import MlConnection from './models/ml-connection'
import ProductMlLink from './models/product-ml-link'
import MlSyncEvent from './models/ml-sync-event'
import MlAppliedOrder from './models/ml-applied-order'
import {
  exchangeCode,
  refreshMlToken,
  getMlUser,
  getSellerItems,
  getItemDetail,
  getItemDescription,
  getMlOrder,
  searchSellerOrders,
  normalizeOrderItems,
  toMlImportItem,
  publishItem,
  updateMlItem,
  updateMlItemDescription,
  setMlItemStatus,
  relistMlItem,
  predictCategory,
  getListingPrices,
  type MlImportItem,
  type MlCategoryCandidate,
  type MlOrder,
} from './client'
import {
  buildListingPriceCacheKey,
  isListingPriceEntryStale,
  type ListingPriceCacheEntry,
} from './listing-price-cache'
import {
  encryptToken,
  decryptToken,
  shouldRefresh,
  sanitizeConnection,
  isDuplicateLink,
  buildMlItemPayload,
  decidePublishAction,
  mlSiteForCountry,
  summarizeSyncEvent,
  type SanitizedMlConnection,
  type MlPublishInput,
  type MlPublishAction,
  type SyncEventInput,
} from './_utils'
import { clampAvailable, shouldPushStock, isUniqueViolationError } from './sync-utils'

/**
 * Mercado Libre module service. Owns the OAuth connection (US-1) and the
 * product↔ML-item linkage (US-2). Tokens are encrypted at rest; the cleartext
 * access token is only ever materialised in-memory by `getAccessTokenForSeller`,
 * never logged, never returned over the wire.
 */
// Module-level fee-estimate cache (Sprint 2 · US-4) — keyed by
// site:category:listingType, since the fee RATE is stable across price
// points but varies per category/listing-type. Not per-seller: two sellers
// asking about the same category/listing-type get the same ML-quoted rate.
const listingPriceCache = new Map<string, ListingPriceCacheEntry>()

class MercadolibreModuleService extends MedusaService({ MlConnection, ProductMlLink, MlSyncEvent, MlAppliedOrder }) {
  // ── Sprint 5 · US-13: sync activity log (append-only, best-effort) ──────────────

  /**
   * Append one activity-log row. **Best-effort by contract**: a failed log write
   * is swallowed (logged to stderr) and MUST never propagate — the log is pure
   * observability and can never be allowed to break a sync action. Shapes +
   * redacts via the pure `summarizeSyncEvent`.
   */
  async recordSyncEvent(input: SyncEventInput): Promise<void> {
    try {
      const shaped = summarizeSyncEvent(input)
      if (!shaped) return
      await this.createMlSyncEvents(shaped)
    } catch (e) {
      console.error('[ml] recordSyncEvent failed (non-fatal):', e instanceof Error ? e.message : e)
    }
  }

  /** Recent activity-log rows for a seller, newest first (the seller status surface). */
  async listSyncEvents(sellerId: string, opts: { limit?: number } = {}) {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200)
    return this.listMlSyncEvents({ seller_id: sellerId }, { take, order: { created_at: 'DESC' } })
  }

  // ── US-1: connection ──────────────────────────────────────────────────────────

  /** Exchange an OAuth code and upsert the encrypted connection keyed to the seller. */
  async connectFromCode(sellerId: string, code: string): Promise<SanitizedMlConnection | null> {
    const tokens = await exchangeCode(code)
    const mlUser = await getMlUser(tokens.access_token)
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)

    const fields = {
      seller_id: sellerId,
      ml_user_id: String(mlUser.id),
      ml_nickname: mlUser.nickname ?? null,
      country_code: mlUser.country_id ?? 'MX',
      access_token_enc: encryptToken(tokens.access_token),
      refresh_token_enc: encryptToken(tokens.refresh_token),
      expires_at: expiresAt,
      status: 'connected' as const,
      last_refreshed_at: new Date(),
    }

    const existing = await this.getConnection(sellerId)
    // On reconnect, clear any needs-reauth/last-error flag but PRESERVE the rest of
    // the connection metadata (per-seller sync enable, reconcile marker).
    const existingMeta = (existing?.metadata ?? {}) as Record<string, unknown>
    const { needs_reauth: _nr, last_error: _le, last_error_at: _lea, ...keepMeta } = existingMeta
    const row = existing
      ? await this.updateMlConnections({ id: existing.id, ...fields, metadata: keepMeta })
      : await this.createMlConnections({ ...fields, metadata: null })
    return sanitizeConnection(Array.isArray(row) ? row[0] : row)
  }

  /** The single connection row for a seller (any status), or null. */
  async getConnection(sellerId: string) {
    const [conn] = await this.listMlConnections({ seller_id: sellerId }, { take: 1 })
    return conn ?? null
  }

  /**
   * The load-bearing primitive every later sprint uses: return a valid access
   * token for the seller, refreshing (and persisting the new tokens) when it is
   * within the refresh-skew window. Never logs the token.
   */
  async getAccessTokenForSeller(sellerId: string): Promise<string> {
    const conn = await this.getConnection(sellerId)
    if (!conn || conn.status !== 'connected') {
      throw Object.assign(new Error('No active MercadoLibre connection'), { code: 'ML_NOT_CONNECTED' })
    }

    if (shouldRefresh(conn.expires_at)) {
      const refresh = decryptToken(conn.refresh_token_enc)
      if (!refresh) throw await this.flagReauth(conn, 'refresh token unavailable')
      let tokens
      try {
        tokens = await refreshMlToken(refresh)
      } catch (e) {
        // A revoked/expired refresh token throws here. BEFORE Sprint 5 this
        // propagated uncaught → a generic 502 while the connection still read
        // `connected`, so the seller never learned they must reconnect. Now we
        // persist a `needs_reauth` flag (surfaced by `deriveConnectionHealth`) and
        // rethrow a tagged code the routes map to a distinct re-auth response.
        throw await this.flagReauth(conn, e instanceof Error ? e.message : String(e))
      }
      const meta = (conn.metadata ?? {}) as Record<string, unknown>
      // Clear any stale reauth flag on a successful refresh (preserve the rest).
      const { needs_reauth: _nr, last_error: _le, last_error_at: _lea, ...keepMeta } = meta
      await this.updateMlConnections({
        id: conn.id,
        access_token_enc: encryptToken(tokens.access_token),
        refresh_token_enc: encryptToken(tokens.refresh_token),
        expires_at: new Date(Date.now() + tokens.expires_in * 1000),
        last_refreshed_at: new Date(),
        metadata: keepMeta,
      })
      return tokens.access_token
    }

    const token = decryptToken(conn.access_token_enc)
    if (!token) throw new Error('ML access token unavailable')
    return token
  }

  /**
   * Mark a connection as needing re-auth (a failed token refresh), record the
   * activity-log event, and RETURN a tagged `ML_REAUTH_REQUIRED` error for the
   * caller to throw. Persisting the flag is best-effort — even if it fails we still
   * surface the tagged error so the request doesn't silently 502.
   */
  private async flagReauth(
    conn: { id: string; seller_id: string; metadata?: Record<string, unknown> | null },
    reason: string,
  ): Promise<Error & { code: string }> {
    try {
      const meta = (conn.metadata ?? {}) as Record<string, unknown>
      await this.updateMlConnections({
        id: conn.id,
        metadata: { ...meta, needs_reauth: true, last_error: 'ML_REAUTH_REQUIRED', last_error_at: new Date().toISOString() },
      })
    } catch (e) {
      console.error('[ml] flagReauth persist failed (non-fatal):', e instanceof Error ? e.message : e)
    }
    await this.recordSyncEvent({
      sellerId: conn.seller_id,
      kind: 'token_refresh',
      outcome: 'fail',
      code: 'ML_REAUTH_REQUIRED',
      message: `Token refresh failed — reconnect required (${reason})`,
    })
    return Object.assign(new Error('MercadoLibre re-authorization required'), { code: 'ML_REAUTH_REQUIRED' })
  }

  /** Clear the connection: mark disconnected and wipe the encrypted token fields. */
  async disconnect(sellerId: string): Promise<{ ok: true }> {
    const conn = await this.getConnection(sellerId)
    if (conn) {
      await this.updateMlConnections({
        id: conn.id,
        status: 'disconnected',
        access_token_enc: '',
        refresh_token_enc: '',
      })
    }
    return { ok: true }
  }

  // ── US-2: product ↔ ML-item linkage ────────────────────────────────────────────

  async linkProductToMlItem(input: {
    sellerId: string
    productId: string
    variantId?: string | null
    mlItemId: string
    metadata?: Record<string, unknown> | null
  }) {
    // Query both directions so the 1:1 guard can reject "product already linked"
    // AND "ML item already linked", not just an exact-pair duplicate.
    const [byProduct, byMlItem] = await Promise.all([
      this.getLinkByProduct(input.productId),
      this.getLinkByMlItem(input.mlItemId),
    ])
    const existing = [byProduct, byMlItem].filter(Boolean) as { product_id: string; ml_item_id: string }[]
    if (isDuplicateLink(existing, { product_id: input.productId, ml_item_id: input.mlItemId })) {
      throw Object.assign(new Error('Product or ML item is already linked'), {
        code: 'ML_LINK_CONFLICT',
      })
    }
    return this.createProductMlLinks({
      seller_id: input.sellerId,
      product_id: input.productId,
      variant_id: input.variantId ?? null,
      ml_item_id: input.mlItemId,
      metadata: input.metadata ?? null,
    })
  }

  async getLinkByProduct(productId: string) {
    const [link] = await this.listProductMlLinks({ product_id: productId }, { take: 1 })
    return link ?? null
  }

  async getLinkByMlItem(mlItemId: string) {
    const [link] = await this.listProductMlLinks({ ml_item_id: mlItemId }, { take: 1 })
    return link ?? null
  }

  async getLink(id: string) {
    const [link] = await this.listProductMlLinks({ id }, { take: 1 })
    return link ?? null
  }

  async unlink(id: string): Promise<{ ok: true }> {
    await this.deleteProductMlLinks(id)
    return { ok: true }
  }

  // ── Sprint 2: import — list the seller's active ML items ─────────────────────────

  /**
   * List a connected seller's active ML items as import-ready rows: page the
   * user's item ids, fetch each item's detail + description, annotate whether it
   * is already linked (so the UI can flag duplicates). Per-item failures are
   * skipped so one bad item never fails the whole page. Tokens never leave here.
   */
  async listActiveImportItems(
    sellerId: string,
    opts: { offset?: number; limit?: number } = {},
  ): Promise<{ items: MlImportItem[]; paging: { total: number; offset: number; limit: number }; skipped: number }> {
    const conn = await this.getConnection(sellerId)
    if (!conn || conn.status !== 'connected') {
      throw Object.assign(new Error('No active MercadoLibre connection'), { code: 'ML_NOT_CONNECTED' })
    }
    const token = await this.getAccessTokenForSeller(sellerId)
    const page = await getSellerItems(token, conn.ml_user_id, opts)

    const items: MlImportItem[] = []
    let skipped = 0
    for (const id of page.results) {
      try {
        const [detail, description, link] = await Promise.all([
          getItemDetail(token, id),
          getItemDescription(token, id).catch(() => ''),
          this.getLinkByMlItem(id),
        ])
        items.push(toMlImportItem(detail, description, !!link))
      } catch {
        skipped++ // one bad item shouldn't fail the whole page
      }
    }
    // But if we found ids and loaded NONE, that's an ML outage (auth / rate-limit /
    // shape change), not an empty catalog — signal it so the UI never shows
    // "nothing to import" on a real failure. (cross-review #45.)
    if (page.results.length > 0 && items.length === 0) {
      throw Object.assign(new Error('Failed to load any ML item detail'), { code: 'ML_FETCH_FAILED' })
    }
    return { items, paging: page.paging, skipped }
  }

  /**
   * ML's fee rate (percentage + fixed fee) for a category/listing-type, cached
   * for `LISTING_PRICE_CACHE_TTL_MS` so the frontend's target-margin slider can
   * recompute `solveForPrice` locally without a network call per tick (Sprint 2
   * · US-4). `referencePriceCents` is only the price ML evaluates the rate AT —
   * the fee rate itself is what's cached and reused across prices in the
   * suggester; Apply (US-5) re-validates against ML directly at write time.
   * Returns `null` on any failure (no connection, ML error) so the route can
   * degrade to an "estimate unavailable" state rather than throw.
   */
  async getFeeEstimate(
    sellerId: string,
    args: { categoryId: string; listingTypeId: string; referencePriceCents: number },
  ): Promise<{ feePct: number; fixedFeeCents: number; currency: string } | null> {
    const key = buildListingPriceCacheKey('_site_pending_', args.categoryId, args.listingTypeId)
    try {
      const conn = await this.getConnection(sellerId)
      if (!conn || conn.status !== 'connected') return null
      const siteId = mlSiteForCountry(conn.country_code)
      const cacheKey = buildListingPriceCacheKey(siteId, args.categoryId, args.listingTypeId)
      const cached = listingPriceCache.get(cacheKey)
      if (!isListingPriceEntryStale(cached, Date.now())) {
        return { feePct: cached!.feePct, fixedFeeCents: cached!.fixedFeeCents, currency: cached!.currency }
      }
      const token = await this.getAccessTokenForSeller(sellerId)
      const referencePrice = Math.max(1, Math.round(args.referencePriceCents / 100))
      const raw = await getListingPrices(token, siteId, {
        price: referencePrice,
        categoryId: args.categoryId,
        listingTypeId: args.listingTypeId,
      })
      const details = raw.sale_fee_details
      // Prefer the rate breakdown; fall back to a single-point-derived
      // percentage (fixed fee unknown ⇒ 0) if ML only returns a flat amount.
      const feePct = typeof details?.percentage_fee === 'number'
        ? details.percentage_fee / 100
        : typeof raw.sale_fee_amount === 'number' && referencePrice > 0
          ? raw.sale_fee_amount / referencePrice
          : null
      if (feePct == null || !Number.isFinite(feePct)) return null
      const fixedFeeCents = typeof details?.fixed_fee === 'number' ? Math.round(details.fixed_fee * 100) : 0
      const currency = raw.currency_id ?? 'MXN'
      listingPriceCache.set(cacheKey, { feePct, fixedFeeCents, currency, fetchedAt: Date.now() })
      return { feePct, fixedFeeCents, currency }
    } catch (e) {
      console.error('[ml] getFeeEstimate failed (degrading to unavailable):', e instanceof Error ? e.message : e, key)
      return null
    }
  }

  // ── Sprint 3: publish / sync (the reconcile seam) ────────────────────────────────

  /**
   * Best-effort close of a product's linked ML item — keyed off the LINK only, so
   * it still works when the Medusa product is soft-deleted/unreadable (the
   * archive/delete hook). Verifies the link belongs to the seller. Idempotent: an
   * already-closed item, or no link, is a noop.
   */
  async closeProductMl(sellerId: string, productId: string): Promise<{
    action: 'close' | 'noop'
    ml_item_id: string | null
    status: string | null
  }> {
    const link = await this.getLinkByProduct(productId)
    if (!link || link.seller_id !== sellerId) return { action: 'noop', ml_item_id: null, status: null }
    const meta = (link.metadata ?? {}) as Record<string, unknown>
    if (meta.ml_status === 'closed') {
      return { action: 'noop', ml_item_id: link.ml_item_id, status: 'closed' }
    }
    const token = await this.getAccessTokenForSeller(sellerId)
    const item = await setMlItemStatus(token, link.ml_item_id, 'closed')
    await this.updateProductMlLinks({
      id: link.id,
      metadata: { ...meta, ml_status: item.status ?? 'closed', last_synced_at: new Date().toISOString() },
    })
    return { action: 'close', ml_item_id: link.ml_item_id, status: item.status ?? 'closed' }
  }

  /**
   * Predict valid ML categories for a product title (US-9). Returns ranked
   * candidates; the FE applies the low-confidence/override decision and never lets
   * publish guess silently. Empty array ⇒ no prediction (the caller falls back to a
   * safe default / asks the seller).
   */
  async predictMlCategory(sellerId: string, query: string): Promise<MlCategoryCandidate[]> {
    const conn = await this.getConnection(sellerId)
    if (!conn || conn.status !== 'connected') {
      throw Object.assign(new Error('No active MercadoLibre connection'), { code: 'ML_NOT_CONNECTED' })
    }
    const token = await this.getAccessTokenForSeller(sellerId)
    return predictCategory(token, mlSiteForCountry(conn.country_code), query)
  }

  /**
   * The single outbound reconcile seam (US-7 + US-8) — create / update / close /
   * relist a Miyagi product's linked ML item from the product's current state.
   * Decides the action from the linkage + statuses (`decidePublishAction`), runs
   * the matching ML write, then persists the linkage + ML state into the link's
   * metadata. Sprint 4's inventory subscriber will call this same method.
   *
   * On a `create` with no `categoryId`, throws `ML_NO_CATEGORY` — the FE resolves
   * the category (predicted/overridden) BEFORE publishing, so the backend never
   * guesses a category on a live external write.
   */
  async publishOrSyncProduct(args: {
    sellerId: string
    productId: string
    variantId?: string | null
    input: MlPublishInput
    productPublished: boolean
    categoryId?: string | null
  }): Promise<{
    action: MlPublishAction
    created: boolean
    ml_item_id: string | null
    permalink: string | null
    status: string | null
  }> {
    const link = await this.getLinkByProduct(args.productId)
    // Defense in depth (mirrors closeProductMl): never act on a link that isn't
    // this seller's — a stale/cross-seller link must not be updated/closed with
    // the caller's token. The route already checks product ownership; this guards
    // the 1:1 link row itself.
    if (link && link.seller_id !== args.sellerId) {
      throw Object.assign(new Error('Product or ML item is already linked'), { code: 'ML_LINK_CONFLICT' })
    }
    const linkMeta = (link?.metadata ?? {}) as Record<string, unknown>
    const action = decidePublishAction({
      linked: !!link,
      mlStatus: (linkMeta.ml_status as string | undefined) ?? null,
      productPublished: args.productPublished,
    })

    // A linked product reconciles via the stored category; a fresh publish needs one.
    const categoryId = args.categoryId || (linkMeta.ml_category_id as string | undefined) || ''

    if (action === 'noop') {
      return {
        action,
        created: false,
        ml_item_id: link?.ml_item_id ?? null,
        permalink: (linkMeta.permalink as string | undefined) ?? null,
        status: (linkMeta.ml_status as string | undefined) ?? null,
      }
    }

    const token = await this.getAccessTokenForSeller(args.sellerId)

    if (action === 'create') {
      if (!categoryId) {
        throw Object.assign(new Error('A category is required to publish'), { code: 'ML_NO_CATEGORY' })
      }
      // Validate locally so a missing title / non-positive price surfaces a clear
      // seller-facing 422 instead of a generic ML 502 (ML would reject these).
      if (!(args.input.title ?? '').trim() || args.input.price_cents == null || args.input.price_cents <= 0) {
        throw Object.assign(new Error('Product needs a title and a price to publish'), { code: 'ML_INVALID_PRODUCT' })
      }
      const payload = buildMlItemPayload(args.input, { categoryId })
      const item = await publishItem(token, payload)
      const meta = {
        ml_status: item.status ?? 'active',
        permalink: item.permalink ?? null,
        ml_category_id: categoryId,
        last_synced_at: new Date().toISOString(),
      }
      await this.linkProductToMlItem({
        sellerId: args.sellerId,
        productId: args.productId,
        variantId: args.variantId ?? null,
        mlItemId: item.id,
        metadata: meta,
      })
      return { action, created: true, ml_item_id: item.id, permalink: item.permalink ?? null, status: meta.ml_status }
    }

    // From here the link exists (any non-create, non-noop action).
    const mlItemId = link!.ml_item_id
    let item

    if (action === 'close') {
      item = await setMlItemStatus(token, mlItemId, 'closed')
    } else {
      // update OR relist — relist reactivates first, then we still sync the fields.
      if (action === 'relist') await relistMlItem(token, mlItemId)
      const payload = buildMlItemPayload(args.input, { categoryId: categoryId || 'unused' })
      item = await updateMlItem(token, mlItemId, {
        title: payload.title,
        price: payload.price,
        available_quantity: payload.available_quantity,
        ...(payload.pictures ? { pictures: payload.pictures } : {}),
      })
      if (payload.description?.plain_text) {
        await updateMlItemDescription(token, mlItemId, payload.description.plain_text)
      }
    }

    const newMeta = {
      ...linkMeta,
      ml_status: item.status ?? (action === 'close' ? 'closed' : 'active'),
      permalink: item.permalink ?? (linkMeta.permalink as string | undefined) ?? null,
      last_synced_at: new Date().toISOString(),
    }
    await this.updateProductMlLinks({ id: link!.id, metadata: newMeta })

    return {
      action,
      created: false,
      ml_item_id: mlItemId,
      permalink: newMeta.permalink as string | null,
      status: newMeta.ml_status as string,
    }
  }

  // ── Sprint 4: two-way stock sync ─────────────────────────────────────────────
  // The per-seller enable lives on the CONNECTION metadata (co-located in the
  // module's own Postgres with the token + linkage — no cross-module hop). Sync
  // runs only when BOTH the global `ml.sync_enabled` flag (checked at each entry
  // point) AND this per-seller flag are on.

  /** Read the per-seller stock-sync enable. Off unless there's a live connection with it set. */
  async isSellerSyncEnabled(sellerId: string): Promise<boolean> {
    const conn = await this.getConnection(sellerId)
    if (!conn || conn.status !== 'connected') return false
    const meta = (conn.metadata ?? {}) as Record<string, unknown>
    return meta.sync_enabled === true
  }

  /** Find the connected connection for an ML user id (the inbound webhook receiver). */
  async getConnectionByMlUser(mlUserId: string) {
    const [conn] = await this.listMlConnections(
      { ml_user_id: String(mlUserId), status: 'connected' },
      { take: 1 },
    )
    return conn ?? null
  }

  /**
   * An ML order's status + per-item sold quantities (inbound webhook · orders_v2).
   * `raw` is the FULL order response (ml-orders-native S1 · US-1) — needed by
   * order materialization, which persists it verbatim (see the plan's fee/
   * shipping capture decision).
   */
  async getMlOrderItems(
    sellerId: string,
    orderId: string,
  ): Promise<{ status: string | null; items: { mlItemId: string; quantity: number }[]; raw: MlOrder }> {
    const token = await this.getAccessTokenForSeller(sellerId)
    const order = await getMlOrder(token, orderId)
    return { status: order.status ?? null, items: normalizeOrderItems(order), raw: order }
  }

  /**
   * A seller's recent ML orders since `sinceIso`, each with status + per-item sold
   * quantities (reconcile job · missed-webhook recovery — US-12). `raw` is the
   * FULL order object `/orders/search` already returns (ml-orders-native S1 ·
   * US-1) — reused for materialization with no extra fetch. Idempotency + the
   * paid-status filter are the caller's job.
   */
  async searchSellerOrdersSince(
    sellerId: string,
    sinceIso: string,
  ): Promise<{
    orders: {
      id: string
      status: string | null
      date_created: string | null
      items: { mlItemId: string; quantity: number }[]
      raw: MlOrder
    }[]
    truncated: boolean
  }> {
    const conn = await this.getConnection(sellerId)
    if (!conn || conn.status !== 'connected') return { orders: [], truncated: false }
    const token = await this.getAccessTokenForSeller(sellerId)
    const { orders, truncated } = await searchSellerOrders(token, conn.ml_user_id, sinceIso)
    return {
      orders: orders
        .map((o) => ({
          id: String(o.id),
          status: o.status ?? null,
          date_created: o.date_created ?? null,
          items: normalizeOrderItems(o),
          raw: o,
        }))
        .filter((o) => o.id && o.items.length > 0),
      truncated,
    }
  }

  /**
   * The durable exactly-once row for (linkId, mlOrderId), or null if this ML order
   * has never been applied to this link (US-0, ml-orders-native S1 — supersedes
   * the capped `ml_applied_orders` metadata ring).
   */
  async getAppliedOrder(linkId: string, mlOrderId: string) {
    if (!mlOrderId) return null
    const [row] = await this.listMlAppliedOrders({ link_id: linkId, ml_order_id: mlOrderId }, { take: 1 })
    return row ?? null
  }

  /**
   * The applied-order row for an already-materialized Medusa order (US-4,
   * ml-orders-native S2). `materializeMlOrder`'s own order metadata doesn't carry
   * `link_id`, so the cancel/refund reconcile path — which only has the Medusa
   * order id — looks the row up by `medusa_order_id` instead (unique in practice:
   * one applied-order row ever sets a given order id).
   */
  async getAppliedOrderByMedusaOrderId(medusaOrderId: string) {
    if (!medusaOrderId) return null
    const [row] = await this.listMlAppliedOrders({ medusa_order_id: medusaOrderId }, { take: 1 })
    return row ?? null
  }

  /**
   * Record an ML order as durably applied, exactly once (US-0). The caller must
   * already hold the per-link Redis lock and have confirmed via `getAppliedOrder`
   * that no row exists yet — this write, plus the stock decrement and (when
   * `ml.orders_enabled`) the Medusa order creation, all happen inside that same
   * lock. The table's `unique(link_id, ml_order_id)` index is defense-in-depth
   * against a lock-service outage: a unique-violation here means a concurrent
   * writer already won the race, so it's read back and returned rather than
   * thrown — never a double-apply, never a hard failure on a benign race.
   */
  async recordAppliedOrder(
    linkId: string,
    mlOrderId: string,
    input: { inventoryDelta: number; medusaOrderId?: string | null },
  ) {
    try {
      const row = await this.createMlAppliedOrders({
        link_id: linkId,
        ml_order_id: mlOrderId,
        medusa_order_id: input.medusaOrderId ?? null,
        inventory_delta: input.inventoryDelta,
        applied_at: new Date(),
      })
      return Array.isArray(row) ? row[0] : row
    } catch (e) {
      if (isUniqueViolationError(e)) return this.getAppliedOrder(linkId, mlOrderId)
      throw e
    }
  }

  /**
   * Stamp a Medusa order id onto an already-applied row whose materialization
   * failed on a prior pass (US-0's `retry-materialize` decision) — the stock
   * decrement was already recorded; this only fills in the missing order side.
   */
  async setAppliedOrderMedusaId(appliedOrderId: string, medusaOrderId: string): Promise<void> {
    await this.updateMlAppliedOrders({ id: appliedOrderId, medusa_order_id: medusaOrderId })
  }

  /**
   * Stamp an applied-order row as cancelled (US-4, ml-orders-native S2) — the
   * exactly-once guarantee for the reverse direction: once set,
   * `decideMlOrderCancel` treats any replayed cancel notification as a no-op.
   */
  async setAppliedOrderCancelled(appliedOrderId: string): Promise<void> {
    await this.updateMlAppliedOrders({ id: appliedOrderId, cancelled_at: new Date() })
  }

  /**
   * Stamp a post-fulfillment cancel/refund edge case as logged (US-4, cross-review
   * fix) — makes `decideMlOrderCancel`'s `log-edge` a ONE-TIME note instead of a
   * repeat every 30-minute reconcile pass forever (nothing about the order's ML or
   * fulfillment status changes on its own to stop it otherwise).
   */
  async setAppliedOrderEdgeLogged(appliedOrderId: string): Promise<void> {
    await this.updateMlAppliedOrders({ id: appliedOrderId, edge_logged_at: new Date() })
  }

  /** Read the reconcile poll marker (ISO) for a seller, or null. */
  async getSellerSyncMarker(sellerId: string): Promise<string | null> {
    const conn = await this.getConnection(sellerId)
    const meta = (conn?.metadata ?? {}) as Record<string, unknown>
    return typeof meta.orders_synced_at === 'string' ? meta.orders_synced_at : null
  }

  /** Advance the reconcile poll marker (ISO) for a seller. */
  async setSellerSyncMarker(sellerId: string, iso: string): Promise<void> {
    const conn = await this.getConnection(sellerId)
    if (!conn) return
    const meta = (conn.metadata ?? {}) as Record<string, unknown>
    await this.updateMlConnections({ id: conn.id, metadata: { ...meta, orders_synced_at: iso } })
  }

  /** Set the per-seller stock-sync enable. No connection ⇒ ML_NOT_CONNECTED. */
  async setSellerSyncEnabled(sellerId: string, enabled: boolean): Promise<{ sync_enabled: boolean }> {
    const conn = await this.getConnection(sellerId)
    if (!conn) throw Object.assign(new Error('No MercadoLibre connection'), { code: 'ML_NOT_CONNECTED' })
    const meta = (conn.metadata ?? {}) as Record<string, unknown>
    await this.updateMlConnections({ id: conn.id, metadata: { ...meta, sync_enabled: enabled } })
    return { sync_enabled: enabled }
  }

  /**
   * Outbound stock push (US-10): set a linked product's ML `available_quantity`
   * to the value Medusa currently reports. The CALLER computes `availableQuantity`
   * from Medusa inventory (available = stocked − reserved) and passes it in — the
   * module owns only the linkage + token + the ML write, so cross-module inventory
   * never has to be resolved in here.
   *
   * Guarantees: enforces the per-seller enable; only ever touches an ACTIVE ML item
   * (a stock push must never silently reopen a closed/paused item); **idempotent**
   * (skips when the value is unchanged since the last push — collapses a burst and
   * is safe on a retried/duplicated trigger); **never throws out of a subscriber**
   * (an ML write failure marks `sync_pending` for the reconcile job to retry).
   * `available` is clamped ≥ 0 so a negative can never be written to ML.
   */
  async pushStockToMl(args: { productId: string; availableQuantity: number; force?: boolean }): Promise<{
    action: 'push' | 'skip' | 'noop' | 'deferred'
    ml_item_id: string | null
    available: number | null
  }> {
    const link = await this.getLinkByProduct(args.productId)
    if (!link) return { action: 'noop', ml_item_id: null, available: null }
    const meta = (link.metadata ?? {}) as Record<string, unknown>
    if (meta.ml_status && meta.ml_status !== 'active') {
      return { action: 'noop', ml_item_id: link.ml_item_id, available: null }
    }
    if (!(await this.isSellerSyncEnabled(link.seller_id))) {
      return { action: 'noop', ml_item_id: link.ml_item_id, available: null }
    }

    const available = clampAvailable(args.availableQuantity)
    const lastPushed = typeof meta.last_pushed_available === 'number' ? meta.last_pushed_available : null
    // `force` (the reconcile job) writes even when the value matches our last push,
    // because ML may have drifted externally since then.
    if (!args.force && !shouldPushStock({ currentAvailable: available, lastPushedAvailable: lastPushed })) {
      return { action: 'skip', ml_item_id: link.ml_item_id, available }
    }

    const token = await this.getAccessTokenForSeller(link.seller_id)
    try {
      await updateMlItem(token, link.ml_item_id, { available_quantity: available })
    } catch (e) {
      // Rate-limit / transient ML failure → defer to the reconcile job. Never throw.
      const msg = e instanceof Error ? e.message : String(e)
      await this.updateProductMlLinks({
        id: link.id,
        metadata: { ...meta, sync_pending: true, last_sync_error: msg, last_synced_at: new Date().toISOString() },
      })
      await this.recordSyncEvent({
        sellerId: link.seller_id,
        kind: 'stock_push',
        outcome: 'fail',
        code: 'deferred',
        productId: args.productId,
        mlItemId: link.ml_item_id,
        message: `Stock push deferred (rate-limit / error): ${msg}`,
        metadata: { available },
      })
      return { action: 'deferred', ml_item_id: link.ml_item_id, available }
    }

    await this.updateProductMlLinks({
      id: link.id,
      metadata: {
        ...meta,
        last_pushed_available: available,
        sync_pending: false,
        last_sync_error: null,
        last_synced_at: new Date().toISOString(),
      },
    })
    await this.recordSyncEvent({
      sellerId: link.seller_id,
      kind: 'stock_push',
      outcome: 'ok',
      productId: args.productId,
      mlItemId: link.ml_item_id,
      message: `Existencia sincronizada a Mercado Libre: ${available}`,
      metadata: { available },
    })
    return { action: 'push', ml_item_id: link.ml_item_id, available }
  }
}

export default MercadolibreModuleService
