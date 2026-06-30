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
      throw new Error('No active MercadoLibre connection')
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
}

export default MercadolibreModuleService
