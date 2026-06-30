import { model } from '@medusajs/framework/utils'

/**
 * ProductMlLink — the durable join between a Medusa product (and optionally a
 * variant) and its Mercado Libre item id. This is the linkage primitive that
 * import (S2), publish (S3), and two-way stock sync (S4) all share.
 *
 * Lookups resolve both directions (Medusa→ML via `product_id`, ML→Medusa via
 * `ml_item_id`). A unique constraint on (`product_id`, `ml_item_id`) rejects a
 * duplicate link; `unlink` soft-deletes (the partial index lets the same pair be
 * re-linked afterwards).
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
    { on: ['product_id', 'ml_item_id'], unique: true, where: 'deleted_at IS NULL' },
  ])

export default ProductMlLink
