import { defineLink } from '@medusajs/framework/utils'
import SellerModule from '../modules/seller'
import ProductModule from '@medusajs/medusa/product'

// One seller has many products.
// Creates a pivot table: seller_id ↔ product_id
export default defineLink(
  SellerModule.linkable.seller,
  ProductModule.linkable.product
)
