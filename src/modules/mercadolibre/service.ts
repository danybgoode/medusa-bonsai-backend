import { MedusaService } from '@medusajs/framework/utils'
import MlConnection from './models/ml-connection'
import ProductMlLink from './models/product-ml-link'
import {
  exchangeCode,
  refreshMlToken,
  getMlUser,
  getSellerItems,
  getItemDetail,
  getItemDescription,
  getMlOrder,
  toMlImportItem,
  publishItem,
  updateMlItem,
  updateMlItemDescription,
  setMlItemStatus,
  relistMlItem,
  predictCategory,
  type MlImportItem,
  type MlCategoryCandidate,
} from './client'
import {
  encryptToken,
  decryptToken,
  shouldRefresh,
  sanitizeConnection,
  isDuplicateLink,
  buildMlItemPayload,
  decidePublishAction,
  mlSiteForCountry,
  type SanitizedMlConnection,
  type MlPublishInput,
  type MlPublishAction,
} from './_utils'
import { clampAvailable, shouldPushStock, recordProcessedNotification } from './sync-utils'

/**
 * Mercado Libre module service. Owns the OAuth connection (US-1) and the
 * product↔ML-item linkage (US-2). Tokens are encrypted at rest; the cleartext
 * access token is only ever materialised in-memory by `getAccessTokenForSeller`,
 * never logged, never returned over the wire.
 */
class MercadolibreModuleService extends MedusaService({ MlConnection, ProductMlLink }) {
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
    const row = existing
      ? await this.updateMlConnections({ id: existing.id, ...fields })
      : await this.createMlConnections(fields)
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
      if (!refresh) throw new Error('ML refresh token unavailable')
      const tokens = await refreshMlToken(refresh)
      await this.updateMlConnections({
        id: conn.id,
        access_token_enc: encryptToken(tokens.access_token),
        refresh_token_enc: encryptToken(tokens.refresh_token),
        expires_at: new Date(Date.now() + tokens.expires_in * 1000),
        last_refreshed_at: new Date(),
      })
      return tokens.access_token
    }

    const token = decryptToken(conn.access_token_enc)
    if (!token) throw new Error('ML access token unavailable')
    return token
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
   * The authoritative available_quantity of a seller's ML item (inbound reconcile
   * — US-11). We re-fetch from ML rather than trusting the webhook body's numbers.
   * Returns null when ML doesn't report a quantity. Clamped ≥ 0.
   */
  async getMlItemAvailable(sellerId: string, mlItemId: string): Promise<number | null> {
    const token = await this.getAccessTokenForSeller(sellerId)
    const detail = await getItemDetail(token, mlItemId)
    return typeof detail.available_quantity === 'number' ? clampAvailable(detail.available_quantity) : null
  }

  /** The ML item ids a given ML order touched (inbound webhook · orders_v2 topic). */
  async getMlOrderItemIds(sellerId: string, orderId: string): Promise<string[]> {
    const token = await this.getAccessTokenForSeller(sellerId)
    const order = await getMlOrder(token, orderId)
    const ids = (order.order_items ?? [])
      .map((oi) => oi?.item?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    return [...new Set(ids)]
  }

  /** Append a processed ML notification id to a link's replay-safe dedupe ring. */
  async markLinkNotificationProcessed(linkId: string, notifId: string): Promise<void> {
    if (!notifId) return
    const link = await this.getLink(linkId)
    if (!link) return
    const meta = (link.metadata ?? {}) as Record<string, unknown>
    const ring = recordProcessedNotification(
      meta.ml_processed_events as { id: string; ts: string }[] | undefined,
      notifId,
    )
    await this.updateProductMlLinks({ id: linkId, metadata: { ...meta, ml_processed_events: ring } })
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
    return { action: 'push', ml_item_id: link.ml_item_id, available }
  }
}

export default MercadolibreModuleService
