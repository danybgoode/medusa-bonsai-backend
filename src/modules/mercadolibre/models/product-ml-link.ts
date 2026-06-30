import { model } from '@medusajs/framework/utils'

/**
 * ProductMlLink — the durable join between a Medusa product (and optionally a
 * variant) and its Mercado Libre item id. This is the linkage primitive that
 * import (S2), publish (S3), and two-way stock sync (S4) all share.
 *
 * It is a **1:1 join**: a product maps to at most one ML item and an ML item to
 * at most one product (separate unique constraints on each), so `getLinkByProduct`
 * / `getLinkByMlItem` resolve **deterministically** and a sync can never address
 * an ambiguous many-to-many. `variant_id` is informational (later per-variant
 * stock targeting); per-variant *separate* ML items would be a deliberate future
 * evolution of this constraint. `unlink` soft-deletes (the partial indexes let the
 * product/item be re-linked afterwards).
 */
const ProductMlLink = model
  .define('product_ml_link', {
    id: model.id({ prefix: 'mll' }).primaryKey(),
    seller_id: model.text(),
    product_id: model.text(),
    variant_id: model.text().nullable(),
    ml_item_id: model.text(),
    metadata: model.json().nullable(),
  })
  .indexes([
    { on: ['product_id'], unique: true, where: 'deleted_at IS NULL' },
    { on: ['ml_item_id'], unique: true, where: 'deleted_at IS NULL' },
  ])

export default ProductMlLink
