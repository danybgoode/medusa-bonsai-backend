import { MedusaService } from '@medusajs/framework/utils'
import MlConnection from './models/ml-connection'
import ProductMlLink from './models/product-ml-link'
import { exchangeCode, refreshMlToken, getMlUser } from './client'
import {
  encryptToken,
  decryptToken,
  shouldRefresh,
  sanitizeConnection,
  isDuplicateLink,
  type SanitizedMlConnection,
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
  }) {
    const existing = await this.listProductMlLinks({ product_id: input.productId })
    if (isDuplicateLink(existing, { product_id: input.productId, ml_item_id: input.mlItemId })) {
      throw new Error('Link already exists for this product and ML item')
    }
    return this.createProductMlLinks({
      seller_id: input.sellerId,
      product_id: input.productId,
      variant_id: input.variantId ?? null,
      ml_item_id: input.mlItemId,
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

  async unlink(id: string): Promise<{ ok: true }> {
    await this.deleteProductMlLinks(id)
    return { ok: true }
  }
}

export default MercadolibreModuleService
