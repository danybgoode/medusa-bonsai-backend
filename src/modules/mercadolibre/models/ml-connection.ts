import { model } from '@medusajs/framework/utils'

/**
 * MlConnection — a seller's Mercado Libre OAuth connection.
 *
 * Keyed to the **Medusa seller** (`seller_id`), not just the Clerk user — this is
 * the fix versus the despachobonsai reference, which keyed connections by
 * `clerk_user_id` only. Tokens are stored **encrypted at rest** (AES-256-GCM, see
 * `_utils.ts`); the cleartext access token is only ever materialised in-memory by
 * `getAccessTokenForSeller`, never logged and never returned over the wire.
 *
 * One row per seller (unique on `seller_id`). Disconnect sets `status` to
 * `disconnected` and clears the encrypted token fields; reconnect updates the
 * same row.
 */
const MlConnection = model
  .define('ml_connection', {
    id: model.id({ prefix: 'mlc' }).primaryKey(),
    // The Medusa seller id (seller.id) this connection belongs to.
    seller_id: model.text(),
    // Mercado Libre user id (numeric, stored as text).
    ml_user_id: model.text(),
    ml_nickname: model.text().nullable(),
    country_code: model.text().default('MX'),
    // AES-256-GCM ciphertext (base64). Never emitted by any route.
    access_token_enc: model.text(),
    refresh_token_enc: model.text(),
    expires_at: model.dateTime(),
    status: model.enum(['connected', 'disconnected']).default('connected'),
    last_refreshed_at: model.dateTime().nullable(),
    metadata: model.json().nullable(),
  })
  .indexes([
    // One ML account per seller (partial, so a soft-deleted row never blocks).
    { on: ['seller_id'], unique: true, where: 'deleted_at IS NULL' },
  ])

export default MlConnection
